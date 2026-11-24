import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import Big from "big.js";
import { readTreasuryBenchmark } from "../facts/read.js";
import type { AgentDb } from "../mcp/agentDb.js";
import { readAgentRegion } from "../users.js";
import { CroatiaOwnerShape, croatiaOwnerCheck, parseCroatiaOwner } from "./ownerCheck.js";

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});
const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

/** Decision 0014: the Croatian obrt and d.o.o. owner check, as a calculator over given facts. */
export function registerCroatiaTools(server: McpServer, db: AgentDb) {
  server.registerTool(
    "croatia_owner_check",
    {
      title: "Croatia: obrt and d.o.o. owner check",
      description:
        "For an owner in Croatia with an obrt (dohodaš) and/or a d.o.o.: euros a year lost to " +
        "where work is billed (obrt contributions and income tax vs company profit tax and 12% " +
        "dividend tax), salary vs dividends from the company, company cash earning less than " +
        "benchmark_rate, and the unused III. stup state incentive; plus personally held shares or " +
        "funds still inside the two-year capital gains window and, with investing enabled, what " +
        "their dividends lose to US and Croatian tax (no US treaty is in force) against an Irish " +
        "accumulating fund, and a US estate tax warning. Give the facts from the owner's " +
        "books (yearly profit before owner pay). Without benchmark_rate the euro €STR from " +
        "Tidysum's facts is used. Pure arithmetic with 2026 public rules and their sources; tell " +
        "the owner to confirm with their accountant before acting.",
      inputSchema: CroatiaOwnerShape,
      annotations: readOnly,
    },
    async (a) => {
      const facts = parseCroatiaOwner(a);
      const extra: string[] = [];
      const region = await readAgentRegion(db).catch(() => null);
      if (region && region.country !== "HR") {
        extra.push(
          `The owner's country is ${region.country}, not Croatia (HR); these are Croatian rules.`,
        );
      }
      if (!facts.benchmark_rate && facts.company?.cash) {
        const bench = await readTreasuryBenchmark(db).catch(() => null);
        if (bench?.name.includes("€STR")) {
          facts.benchmark_rate = new Big(bench.yield).div(100).round(6).toFixed();
          extra.push(`benchmark_rate is ${bench.name} on ${bench.as_of}, ${bench.yield}%.`);
        }
      }
      const { rows } = await db
        .query<{ investing_enabled: boolean }>("select investing_enabled from app_user")
        .catch(() => ({ rows: [] as { investing_enabled: boolean }[] }));
      const report = croatiaOwnerCheck(facts, { investing: rows[0]?.investing_enabled ?? false });
      report.warnings.push(...extra);
      return json(report);
    },
  );
}
