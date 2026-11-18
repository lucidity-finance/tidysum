import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { TokenCipher } from "../src/crypto/tokenCipher.js";
import { connect } from "../src/db/client.js";
import { balanceSnapshot, item, syncRun, transaction } from "../src/db/schema.js";
import {
  type CsvImportOptions,
  importCsv,
  parseAmount,
  parseCsv,
  parseDate,
} from "../src/ingest/csv.js";
import { SyncScheduler } from "../src/sync/scheduler.js";
import { FakePlaid } from "./fakePlaid.js";
import { ownerUserId } from "./users.js";

describe("parseCsv", () => {
  it("handles quotes, embedded commas and newlines, CRLF and a BOM", () => {
    const text =
      '﻿Date,Description,Amount\r\n2026-10-01,"Coffee, ""large""",4.50\r\n2026-10-02,"two\nlines",1\r\n';
    expect(parseCsv(text)).toEqual([
      ["Date", "Description", "Amount"],
      ["2026-10-01", 'Coffee, "large"', "4.50"],
      ["2026-10-02", "two\nlines", "1"],
    ]);
  });

  it("rejects an unterminated quote", () => {
    expect(() => parseCsv('a,"b\n')).toThrow(/unterminated/);
  });
});

describe("parseAmount", () => {
  it.each([
    ["4.50", "4.50"],
    ["$1,234.56", "1234.56"],
    ["-12.30", "-12.30"],
    ["(12.30)", "-12.30"],
    ["+7", "7"],
    [".5", "0.5"],
    ["-0.00", "0.00"],
  ])("%s -> %s", (raw, expected) => {
    expect(parseAmount(raw)).toBe(expected);
  });

  it.each(["", "abc", "1.2.3", "1e5"])("rejects %j", (raw) => {
    expect(() => parseAmount(raw)).toThrow();
  });
});

describe("parseDate", () => {
  it.each([
    ["2026-10-01", "2026-10-01"],
    ["10/01/2026", "2026-10-01"],
    ["1/5/26", "2026-01-05"],
  ])("%s -> %s", (raw, expected) => {
    expect(parseDate(raw)).toBe(expected);
  });

  it.each(["2026-02-30", "13/01/2026", "yesterday"])("rejects %s", (raw) => {
    expect(() => parseDate(raw)).toThrow();
  });
});

describe("importCsv", () => {
  const h = connect(inject("databaseUrl"));
  const { db } = h;
  afterAll(() => h.close());
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE item, security CASCADE`);
  });

  let opts: CsvImportOptions;
  beforeAll(async () => {
    opts = { ...baseOpts, userId: await ownerUserId(db) };
  });
  const baseOpts: Omit<CsvImportOptions, "userId"> = {
    institution: "Apple",
    account: "Apple Card",
    type: "credit",
    subtype: "credit card",
    currency: "USD",
    columns: { date: "Transaction Date", amount: "Amount (USD)", description: "Description" },
    flipSign: false,
  };
  const csv = [
    "Transaction Date,Description,Amount (USD)",
    "10/01/2026,Coffee,4.50",
    "10/01/2026,Coffee,4.50",
    "10/02/2026,Payment,-500.00",
  ].join("\n");

  it("imports rows, keeps same-day duplicates, and is idempotent", async () => {
    const first = await importCsv(db, csv, opts);
    expect(first).toMatchObject({ inserted: 3, skipped: 0 });

    const overlapping = `${csv}\n10/03/2026,Groceries,80.10`;
    const second = await importCsv(db, overlapping, opts);
    expect(second).toMatchObject({ inserted: 1, skipped: 3, itemId: first.itemId });

    const rows = await db.select().from(transaction).orderBy(transaction.date);
    expect(rows.map((r) => [r.date, r.amount, r.name])).toEqual([
      ["2026-10-01", "4.5000", "Coffee"],
      ["2026-10-01", "4.5000", "Coffee"],
      ["2026-10-02", "-500.0000", "Payment"],
      ["2026-10-03", "80.1000", "Groceries"],
    ]);
    const [it] = await db.select().from(item).where(eq(item.id, first.itemId));
    expect(it).toMatchObject({ source: "csv", institutionName: "Apple", status: "active" });
  });

  it("is never picked up by the Plaid sync", async () => {
    await importCsv(db, csv, opts);
    const plaid = new FakePlaid();
    const scheduler = new SyncScheduler(
      db,
      plaid,
      new TokenCipher(randomBytes(32).toString("base64")),
    );
    await scheduler.syncAll();
    expect(plaid.syncCalls).toEqual([]);
    expect(await db.select().from(syncRun)).toHaveLength(0);
  });

  it("flips signs for bank exports and snapshots a given balance", async () => {
    const bank = "Date,Memo,Amount\n2026-10-01,Rent,-2000.00\n2026-10-02,Salary,5000";
    await importCsv(db, bank, {
      ...opts,
      institution: "Credit Union",
      account: "Checking",
      type: "depository",
      columns: { date: "Date", amount: "Amount", description: "Memo" },
      flipSign: true,
      balance: "$3,000.00",
    });
    const rows = await db.select().from(transaction).orderBy(transaction.date);
    expect(rows.map((r) => r.amount)).toEqual(["2000.0000", "-5000.0000"]);
    const [bal] = await db.select().from(balanceSnapshot);
    expect(bal?.current).toBe("3000.0000");
  });

  it("names the line and column when a row is bad, and writes nothing", async () => {
    await expect(importCsv(db, `${csv}\n10/04/2026,Oops,abc`, opts)).rejects.toThrow(/line 5/);
    await expect(
      importCsv(db, csv, { ...opts, columns: { ...opts.columns, amount: "Amount" } }),
    ).rejects.toThrow(/column "Amount" not found/);
    expect(await db.select().from(transaction)).toHaveLength(0);
  });
});
