import type { AgentDb } from "../mcp/agentDb.js";
import type { SecurityCatalog } from "../portfolio/securityCatalog.js";
import type { CardCatalog } from "../products/cardCatalog.js";
import type { Catalog } from "../products/catalog.js";
import { checkedCards, checkedDeposits, readFactChecks } from "./checks.js";
import { readFundFees } from "./read.js";

interface Loaders {
  loadCatalog: () => Promise<Catalog>;
  loadCardCatalog?: () => Promise<CardCatalog>;
  loadSecurityCatalog?: () => Promise<SecurityCatalog>;
}

/** Fills each catalog fund's missing expense ratio from the SEC's data; stated ones stay. */
export async function withSecFees(catalog: SecurityCatalog, db: AgentDb): Promise<SecurityCatalog> {
  const missing = catalog.securities.filter((s) => !s.expense_ratio).map((s) => s.ticker);
  const fees = await readFundFees(db, missing);
  if (fees.size === 0) return catalog;
  return {
    ...catalog,
    securities: catalog.securities.map((s) => {
      const fee = s.expense_ratio ? undefined : fees.get(s.ticker);
      return fee ? { ...s, expense_ratio: fee.expense_ratio } : s;
    }),
  };
}

/**
 * The catalogs as Tidysum uses them: the checked-in files, with agents' fact checks laid over the
 * deposit and card catalogs and the SEC's fees filling funds' missing expense ratios.
 */
export function withPublicFacts<T extends Loaders>(loaders: T, db: AgentDb): T {
  const { loadCatalog, loadCardCatalog, loadSecurityCatalog } = loaders;
  return {
    ...loaders,
    loadCatalog: async () => checkedDeposits(await loadCatalog(), await readFactChecks(db)),
    ...(loadCardCatalog
      ? {
          loadCardCatalog: async () =>
            checkedCards(await loadCardCatalog(), await readFactChecks(db)),
        }
      : {}),
    ...(loadSecurityCatalog
      ? { loadSecurityCatalog: async () => withSecFees(await loadSecurityCatalog(), db) }
      : {}),
  };
}
