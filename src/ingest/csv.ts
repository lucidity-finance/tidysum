import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { account, balanceSnapshot, item, transaction } from "../db/schema.js";

/** RFC 4180: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === "") {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (quoted) throw new Error("unterminated quoted field");
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

/** "$1,234.56", "-12.30", "(12.30)" → a decimal string. Never goes through a JS number. */
export function parseAmount(raw: string): string {
  let s = raw.trim().replace(/[$,\s]/g, "");
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(s) && !/^\.\d+$/.test(s)) throw new Error(`not an amount: ${raw}`);
  if (s.startsWith(".")) s = `0${s}`;
  const zero = /^0+(\.0+)?$/.test(s);
  return negative && !zero ? `-${s}` : s;
}

export function negate(amount: string): string {
  if (/^0+(\.0+)?$/.test(amount)) return amount;
  return amount.startsWith("-") ? amount.slice(1) : `-${amount}`;
}

/** YYYY-MM-DD, MM/DD/YYYY or M/D/YY → YYYY-MM-DD. */
export function parseDate(raw: string): string {
  const s = raw.trim();
  let y: number;
  let m: number;
  let d: number;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (iso) {
    [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else if (us) {
    [m, d, y] = [Number(us[1]), Number(us[2]), Number(us[3])];
    if (y < 100) y += 2000;
  } else {
    throw new Error(`not a date: ${raw}`);
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw new Error(`not a date: ${raw}`);
  }
  return date.toISOString().slice(0, 10);
}

export interface CsvImportOptions {
  /** Whose data this is. */
  userId: string;
  institution: string;
  account: string;
  type: string;
  subtype?: string;
  currency: string;
  columns: { date: string; amount: string; description: string };
  /**
   * Tidysum stores amounts as positive = money out (Plaid's convention). Set this for exports
   * where purchases are negative, which is most bank CSVs.
   */
  flipSign: boolean;
  /** Current balance to snapshot, if the export doesn't carry one. */
  balance?: string;
}

export interface CsvImportResult {
  itemId: string;
  accountId: string;
  inserted: number;
  skipped: number;
}

export async function importCsv(
  db: Db,
  text: string,
  opts: CsvImportOptions,
  now: Date = new Date(),
): Promise<CsvImportResult> {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new Error("empty CSV");
  const col = (name: string) => {
    const i = header.findIndex((h) => h.trim().toLowerCase() === name.trim().toLowerCase());
    if (i < 0) throw new Error(`column "${name}" not found; columns are: ${header.join(", ")}`);
    return i;
  };
  const [dateCol, amountCol, descCol] = [
    col(opts.columns.date),
    col(opts.columns.amount),
    col(opts.columns.description),
  ];

  const parsed = rows.map((r, i) => {
    const line = i + 2;
    try {
      const amount = parseAmount(r[amountCol] ?? "");
      return {
        date: parseDate(r[dateCol] ?? ""),
        amount: opts.flipSign ? negate(amount) : amount,
        description: (r[descCol] ?? "").trim(),
      };
    } catch (err) {
      throw new Error(`line ${line}: ${(err as Error).message}`);
    }
  });

  return db.transaction(async (tx) => {
    let [it] = await tx
      .select({ id: item.id })
      .from(item)
      .where(
        and(
          eq(item.userId, opts.userId),
          eq(item.source, "csv"),
          eq(item.institutionName, opts.institution),
        ),
      );
    if (!it) {
      [it] = await tx
        .insert(item)
        .values({ userId: opts.userId, source: "csv", institutionName: opts.institution })
        .returning({ id: item.id });
    }
    if (!it) throw new Error("item insert returned no row");

    let [acc] = await tx
      .select({ id: account.id })
      .from(account)
      .where(and(eq(account.itemId, it.id), eq(account.name, opts.account)));
    if (!acc) {
      [acc] = await tx
        .insert(account)
        .values({
          userId: opts.userId,
          itemId: it.id,
          name: opts.account,
          type: opts.type,
          subtype: opts.subtype ?? null,
          currency: opts.currency,
        })
        .returning({ id: account.id });
    }
    if (!acc) throw new Error("account insert returned no row");
    const accountId = acc.id;

    // Identical rows (two same-day coffees) stay distinct through their ordinal in the file.
    const seen = new Map<string, number>();
    const values = parsed.map((p) => {
      const key = `${accountId}|${p.date}|${p.amount}|${p.description}`;
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      return {
        userId: opts.userId,
        accountId,
        csvFingerprint: createHash("sha256").update(`${key}|${n}`).digest("hex"),
        date: p.date,
        amount: p.amount,
        currency: opts.currency,
        name: p.description,
        pending: false,
      };
    });
    let inserted = 0;
    for (let i = 0; i < values.length; i += 500) {
      const batch = values.slice(i, i + 500);
      if (batch.length === 0) continue;
      const rowsIn = await tx
        .insert(transaction)
        .values(batch)
        .onConflictDoNothing({ target: transaction.csvFingerprint })
        .returning({ id: transaction.id });
      inserted += rowsIn.length;
    }
    if (opts.balance !== undefined) {
      await tx.insert(balanceSnapshot).values({
        userId: opts.userId,
        accountId,
        current: parseAmount(opts.balance),
        currency: opts.currency,
        asOf: now,
      });
    }
    await tx.update(item).set({ lastSyncedAt: now }).where(eq(item.id, it.id));
    return { itemId: it.id, accountId, inserted, skipped: values.length - inserted };
  });
}
