import { eq } from "drizzle-orm";
import { afterAll, describe, expect, inject, it } from "vitest";
import { listActions, timingOf } from "../src/actions/actions.js";
import { startAction } from "../src/actions/agentRun.js";
import {
  checkSchedule,
  type Notify,
  parseSchedule,
  scheduleAction,
} from "../src/actions/schedule.js";
import { connect } from "../src/db/client.js";
import { appUser, marketReading } from "../src/db/schema.js";
import {
  calmFrom,
  parseCboeQuote,
  parseFredCsv,
  readCalm,
  recordReadings,
  refreshVix,
  VIX_SERIES,
} from "../src/market/calm.js";
import { connectAgent, connectProposer } from "../src/mcp/agentDb.js";
import { parsePolicy } from "../src/policy/policy.js";
import { approveProposal } from "../src/policy/proposals.js";
import { activatePolicy } from "../src/policy/store.js";

const owner = connect(inject("databaseUrl"));
const [user] = await owner.db
  .insert(appUser)
  .values({ displayName: "Calm test", investingEnabled: true })
  .returning({ id: appUser.id });
if (!user) throw new Error("no user");
const userId = user.id;
const agentDb = connectAgent(inject("databaseUrl"), userId);
const proposer = connectProposer(inject("databaseUrl"), userId);
await activatePolicy(
  owner.db,
  userId,
  parsePolicy({ version: 1, cash: { buffer: { amount: "500" }, tolerance: "100" } }),
);

afterAll(async () => {
  await owner.db.delete(marketReading).where(eq(marketReading.series, VIX_SERIES));
  await agentDb.end();
  await proposer.end();
  await owner.close();
});

describe("calm markets", () => {
  it("reads FRED's CSV, skipping missing days", () => {
    expect(
      parseFredCsv(
        "observation_date,VIXCLS\r\n2031-03-03,17.25\r\n2031-03-04,.\r\n2031-03-05,22.1\r\n",
      ),
    ).toEqual([
      { day: "2031-03-03", value: "17.25" },
      { day: "2031-03-05", value: "22.1" },
    ]);
    expect(parseFredCsv("<html>Not found</html>")).toEqual([]);
  });

  it("is calm after five closes at or below 20, with no spike above 25 in three weeks", () => {
    const quiet = run("2031-02-10", Array(15).fill("17"));
    expect(calmFrom(quiet, "2031-02-25")).toEqual({
      calm: true,
      vix: "17",
      as_of: "2031-02-24",
      threshold: "20",
      peak: "17.00",
      spike: "25",
    });
    // One of the last five above 20.
    const jumpy = [...quiet.slice(0, -1), { day: "2031-02-24", value: "20.01" }];
    expect(calmFrom(jumpy, "2031-02-25")).toMatchObject({ calm: false, vix: "20.01" });
    // A spike above 25 two weeks ago, quiet since: its aftershocks aren't over.
    const spiked = quiet.map((r, i) => (i === 2 ? { ...r, value: "28.18" } : r));
    expect(calmFrom(spiked, "2031-02-25")).toMatchObject({ calm: false, peak: "28.18" });
    // Too few closes to know, or too old to go by.
    expect(calmFrom(quiet.slice(1), "2031-02-25").calm).toBe(false);
    expect(calmFrom(quiet, "2031-03-01").calm).toBe(false);
    expect(calmFrom([], "2031-02-25")).toMatchObject({ calm: false, vix: null, peak: null });
  });

  it("wasn't calm on 2026-11-16, nor on the Friday before", () => {
    // FRED's VIXCLS closes, then Cboe's close for Monday 2026-11-16 (tech sell-off, 22.91).
    const fred = [
      ["2026-10-23", "19.45"],
      ["2026-10-26", "18.39"],
      ["2026-10-27", "17.52"],
      ["2026-10-28", "16.91"],
      ["2026-10-29", "17.20"],
      ["2026-10-30", "19.42"],
      ["2026-11-02", "21.15"],
      ["2026-11-03", "20.83"],
      ["2026-11-04", "16.61"],
      ["2026-11-05", "28.18"],
      ["2026-11-06", "25.64"],
      ["2026-11-09", "19.92"],
      ["2026-11-10", "19.46"],
      ["2026-11-11", "17.49"],
      ["2026-11-12", "18.70"],
      ["2026-11-13", "19.30"],
    ].map(([day, value]) => ({ day: day as string, value: value as string }));
    // Five closes under 20, but the Nov 5 spike to 28 is less than three weeks back.
    expect(calmFrom(fred, "2026-11-14")).toMatchObject({ calm: false, peak: "28.18" });
    expect(calmFrom([...fred, { day: "2026-11-16", value: "22.91" }], "2026-11-16")).toMatchObject({
      calm: false,
      vix: "22.91",
    });
  });

  it("reads Cboe's quote as today's level", () => {
    expect(
      parseCboeQuote({
        data: { current_price: 22.91, last_trade_time: "2026-11-16T16:15:01" },
      }),
    ).toEqual({ day: "2026-11-16", value: "22.9100" });
    expect(parseCboeQuote({ data: { current_price: null, last_trade_time: "x" } })).toBeNull();
    expect(parseCboeQuote("<html>")).toBeNull();
  });

  it("holds an action that waits for it, whatever its days", () => {
    const a = { not_before: null, due_by: null, wait_for: "calm_markets" };
    expect(timingOf(a, "2031-03-06", { calm: false })).toBe("waiting");
    expect(timingOf(a, "2031-03-06", null)).toBe("waiting");
    expect(timingOf(a, "2031-03-06", { calm: true })).toBe("due");
    // Its first day still comes first.
    expect(timingOf({ ...a, not_before: "2031-03-09" }, "2031-03-06", { calm: true })).toBe(
      "scheduled",
    );
  });

  it("reads today's VIX hourly, starts a waiting action when calm, and holds it again", async () => {
    const asked = { fred: 0, cboe: 0 };
    let quote = { current_price: 27.1, last_trade_time: "2031-03-06T10:30:00" };
    const fetchers = {
      fred: (async () => {
        asked.fred++;
        // A month of quiet closes, then a spike; FRED's today, if any, is left to the quote.
        const rows = run("2031-02-04", [...Array(29).fill("15"), "26.3", "99"]);
        return new Response(
          `observation_date,VIXCLS\n${rows.map((r) => `${r.day},${r.value}`).join("\n")}\n`,
        );
      }) as unknown as typeof fetch,
      cboe: (async () => {
        asked.cboe++;
        return new Response(JSON.stringify({ data: quote }));
      }) as unknown as typeof fetch,
    };

    const morning = new Date("2031-03-06T15:00:00Z");
    expect(await refreshVix(owner.db, "2031-03-06", fetchers, morning)).toBe(31);
    expect(await readCalm(agentDb, "2031-03-06")).toMatchObject({
      calm: false,
      vix: "27.1000",
      as_of: "2031-03-06",
    });
    // An hour later: Cboe again for today, FRED not until twelve hours have passed.
    quote = { ...quote, current_price: 25.4 };
    expect(
      await refreshVix(owner.db, "2031-03-06", fetchers, new Date("2031-03-06T16:00:00Z")),
    ).toBe(1);
    expect(asked).toEqual({ fred: 1, cboe: 2 });
    expect(await readCalm(agentDb, "2031-03-06")).toMatchObject({ vix: "25.4000" });
    await refreshVix(owner.db, "2031-03-06", fetchers, new Date("2031-03-07T04:00:00Z"));
    expect(asked).toEqual({ fred: 2, cboe: 3 });
    // A source that fails says so, and the other still counts.
    await expect(
      refreshVix(
        owner.db,
        "2031-03-06",
        { ...fetchers, cboe: (async () => new Response("", { status: 503 })) as never },
        new Date("2031-03-07T05:00:00Z"),
      ),
    ).rejects.toThrow(/Cboe VIX quote: HTTP 503/);

    const r = await scheduleAction(
      owner.db,
      userId,
      parseSchedule({
        title: "Move the brokerage window back into the plan",
        rationale: "Sell in a calm stretch.",
        category: "securities",
        steps: [{ text: "Sell everything in the window", by: "agent", needs_you: "Sign-in" }],
        wait_for: "calm_markets",
        finding_key: "brokerage_window:calm-test",
      }),
      "owner",
      "2031-03-06",
    );
    expect(r).toMatchObject({ state: "proposed", not_before: null, due_by: null });
    await approveProposal(owner.db, agentDb, userId, r.id, "2031-03-06", "admin");

    const held = await listActions(agentDb, "2031-03-06");
    expect(held.scheduled.find((a) => a.id === r.id)).toMatchObject({
      timing: "waiting",
      wait_for: "calm_markets",
      market: { calm: false, vix: "25.4000", as_of: "2031-03-06" },
    });
    expect(held.in_progress.map((a) => a.id)).not.toContain(r.id);
    await expect(startAction(agentDb, proposer, r.id, "mcp:test")).rejects.toThrow(
      /waits for calm markets/,
    );
    const told: string[] = [];
    const notify: Notify = async (title, body) => void told.push(`${title}: ${body}`);
    const still = await checkSchedule(owner.db, agentDb, userId, "2031-03-06", { notify });
    expect(still.due).not.toContain(r.id);
    expect(still.waiting).not.toContain(r.id);

    // Three quiet weeks: due, told, and handed to the agent.
    await recordReadings(owner.db, VIX_SERIES, run("2031-03-07", Array(15).fill("17.7")));
    const started: string[] = [];
    const dispatch = async (a: { id: string }) => void started.push(a.id);
    const calm = await checkSchedule(owner.db, agentDb, userId, "2031-03-21", { notify, dispatch });
    expect(calm.due).toContain(r.id);
    expect(started).toContain(r.id);
    expect(told).toContain(
      "Tidysum: markets are calm: Move the brokerage window back into the plan. The VIX is 17.7000. Your agent is starting on it.",
    );
    const now = await listActions(agentDb, "2031-03-21");
    expect(now.in_progress.find((a) => a.id === r.id)).toMatchObject({ timing: "due" });

    // A jumpy day: it waits again, and the owner is told once.
    await recordReadings(owner.db, VIX_SERIES, [{ day: "2031-03-22", value: "23" }]);
    const jumpy = await checkSchedule(owner.db, agentDb, userId, "2031-03-22", { notify });
    expect(jumpy.waiting).toEqual([r.id]);
    expect(told.at(-1)).toBe(
      "Tidysum: markets turned jumpy: Move the brokerage window back into the plan waits again: the VIX is 23.0. Don't start it until Tidysum says markets are calm.",
    );
    expect(
      (await checkSchedule(owner.db, agentDb, userId, "2031-03-22", { notify })).waiting,
    ).toEqual([]);
    await expect(startAction(agentDb, proposer, r.id, "mcp:test")).rejects.toThrow(
      /waits for calm markets/,
    );

    // Calm again five closes later (23 is no spike): due afresh, and told again.
    await recordReadings(owner.db, VIX_SERIES, run("2031-03-23", Array(5).fill("18")));
    const again = await checkSchedule(owner.db, agentDb, userId, "2031-03-27", {
      notify,
      dispatch,
    });
    expect(again.due).toContain(r.id);
    expect(told.filter((t) => t.startsWith("Tidysum: markets are calm"))).toHaveLength(2);
  });
});

/** Closes on consecutive days from `start`. */
function run(start: string, values: string[]) {
  return values.map((value, i) => ({
    day: new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10),
    value,
  }));
}
