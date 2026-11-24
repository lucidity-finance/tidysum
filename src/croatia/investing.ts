import Big from "big.js";
import type { CroatiaRules } from "./rules.js";

// Decision 0014: what dividends from personally held shares and funds lose to tax, for an owner
// in Croatia. Croatia taxes a dividend when it is paid (12%) and credits foreign tax only up to
// that, so a US dividend that loses 30% at source loses 30% in all. An Irish fund that
// accumulates pays 15% on its US dividends inside the fund and nothing in Croatia until it is
// sold, and nothing then after two years. Investment advice, so it runs only with investing on.

export interface TaxLot {
  name: string;
  value: string;
  acquired?: string;
  cost?: string;
  /** Where the security is domiciled: "US" for US stocks and US ETFs, "IE" or "LU" for UCITS. */
  domicile?: "US" | "IE" | "LU" | "HR" | "other";
  kind?: "stock" | "fund";
  distributing?: boolean;
  /** Yearly dividends as a fraction of value, before any tax (0.015 for 1.5%). */
  dividend_yield?: string;
  /** The share of a fund's holdings in US companies (FTSE All-World about 0.6). */
  us_share?: string;
}

export interface DividendFinding {
  key: string;
  kind: "dividend_tax";
  summary: string;
  annual_cost: string;
  currency: "EUR";
  action: string;
  inputs: Record<string, string>;
}

const ONE = new Big(1);
const eur = (b: Big) => b.round(2, Big.roundHalfUp).toFixed(2);
const pct = (b: Big) => `${b.times(100).round(1).toFixed()}%`;

/** The share of a lot's dividends lost to tax at source and in Croatia, all told. */
export function dividendLeak(lot: TaxLot, r: CroatiaRules): Big | null {
  if (!lot.domicile) return null;
  const cb = r.cross_border;
  const home = new Big(r.dividend_tax);
  if (lot.domicile === "US") {
    // Croatia's 12% is credited against the US tax, which is higher.
    const us = new Big(cb.us_withholding);
    return us.gt(home) ? us : home;
  }
  if (lot.kind === "stock" || lot.domicile === "HR")
    return lot.distributing === false ? null : home;
  const us = new Big(lot.us_share ?? "0");
  const atSource = us.times(
    lot.domicile === "IE" ? cb.ireland_fund_us_withholding : cb.other_fund_us_withholding,
  );
  if (lot.distributing === false) return atSource;
  return ONE.minus(ONE.minus(atSource).times(ONE.minus(home)));
}

/** The least a fund with the same holdings could lose: Irish and accumulating. */
function bestLeak(lot: TaxLot, r: CroatiaRules): Big {
  const us = lot.domicile === "US" ? ONE : new Big(lot.us_share ?? "0");
  return us.times(r.cross_border.ireland_fund_us_withholding);
}

export function dividendFindings(
  lots: TaxLot[],
  r: CroatiaRules,
  usdPerEur: string | undefined,
  warnings: string[],
): DividendFinding[] {
  const out: DividendFinding[] = [];
  let usSitus = new Big(0);
  for (const lot of lots) {
    if (lot.domicile === "US") usSitus = usSitus.plus(lot.value);
    const leak = dividendLeak(lot, r);
    if (!leak || !lot.dividend_yield) continue;
    const best = bestLeak(lot, r);
    const gap = leak.minus(best);
    const cost = new Big(lot.value).times(lot.dividend_yield).times(gap);
    if (gap.lte(0) || cost.lt(1)) continue;
    const why =
      lot.domicile === "US"
        ? `a US security's dividends lose ${pct(leak)} at source with no US treaty in force`
        : lot.distributing === false
          ? `its US dividends lose ${pct(leak)} inside a fund not domiciled in Ireland`
          : `its distributions pay ${pct(new Big(r.dividend_tax))} in Croatia, ${pct(leak)} lost in all`;
    out.push({
      key: `hr:dividend_tax:${lot.name}`,
      kind: "dividend_tax",
      summary:
        `${lot.name}: ${why}; an Irish accumulating fund with the same holdings would lose ` +
        `${pct(best)}, EUR ${eur(cost)} a year less.`,
      annual_cost: eur(cost),
      currency: "EUR",
      action:
        "Buy an Irish-domiciled accumulating UCITS fund for new money; switch what is held once its " +
        "gain is tax-free (two years after buying) or the switch's tax is less than a few years of this.",
      inputs: {
        value: eur(new Big(lot.value)),
        dividend_yield: lot.dividend_yield,
        lost_now: leak.toFixed(4),
        lost_best: best.toFixed(4),
      },
    });
  }
  if (usSitus.gt(0)) {
    const limit = new Big(r.cross_border.us_estate_exemption_usd);
    const usd = usdPerEur ? usSitus.times(usdPerEur) : null;
    // Without an exchange rate, warn well before the limit could be reached in euros.
    if (usd ? usd.gt(limit) : usSitus.gt(limit.times("0.75"))) {
      warnings.push(
        `EUR ${eur(usSitus)} is in US stocks or US funds${usd ? ` (USD ${eur(usd)})` : ""}. For a ` +
          `non-US person the US taxes such assets above USD ${eur(limit)} at death, up to 40%, and ` +
          "no US treaty covers Croatia. Irish-domiciled funds are not US assets.",
      );
    }
  }
  return out;
}
