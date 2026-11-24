// Croatian tax rules for a person who owns an obrt and a d.o.o. (docs/decisions/0014-croatia-owner.md).
// Every rate here is public law, not a personal value. They change by law and some every January
// (the contribution bases follow the average wage), so each year's rules carry their sources and a
// date they were checked, and a user's facts file can override any of them.

export interface CroatiaRules {
  year: number;
  /** The day these were last checked against their sources. */
  checked_on: string;
  /** Porez na dobit: the lower rate up to a year's revenue of `revenue_threshold`, the higher above. */
  profit_tax: { lower: string; higher: string; revenue_threshold: string };
  /** Porez na dohodak od kapitala on dividends and profit shares paid to a resident: final, no allowance. */
  dividend_tax: string;
  /** Capital gains on shares and fund units: taxed if sold within `exempt_after_years` of buying. */
  capital_gains: { rate: string; exempt_after_years: number };
  /** Employment: pension pillars I and II come out of gross pay, health is paid on top by the employer. */
  employee: { pension_1: string; pension_2: string; health: string };
  /**
   * An obrt that keeps books (dohodaš): pension and health on a monthly base that follows last
   * year's income (dohodak / 12), never below `min_base_monthly` nor above `max_base_monthly`.
   */
  self_employed: { pension: string; health: string; min_base_monthly: string };
  /** Najviša osnovica: no pension contribution is charged on pay above it. */
  max_base_monthly: string;
  /** Osnovni osobni odbitak, per month. */
  personal_allowance_monthly: string;
  /** Yearly taxable income taxed at the lower rate; above it, the higher rate. */
  bracket_annual: string;
  /** The city sets its two income tax rates within the law's ranges; Zagreb by default. */
  city_rates: { city: string; lower: string; higher: string };
  /** III. stup: the state adds `incentive_rate` of a year's contributions, up to `incentive_cap_contribution`. */
  pillar3: { incentive_rate: string; incentive_cap_contribution: string };
  /**
   * Investing from Croatia across borders. With no US treaty in force, the US keeps
   * `us_withholding` of US dividends paid to a Croatian resident, and Croatia credits foreign tax
   * only up to its own dividend tax. An Irish fund pays `ireland_fund_us_withholding` on its US
   * dividends under the Ireland-US treaty and Ireland withholds nothing from non-residents. US
   * stocks and US funds are US estate tax assets above `us_estate_exemption_usd`.
   */
  cross_border: {
    us_treaty_in_force: boolean;
    us_withholding: string;
    ireland_fund_us_withholding: string;
    other_fund_us_withholding: string;
    us_estate_exemption_usd: string;
  };
  sources: { what: string; url: string }[];
}

export const HR_RULES_2026: CroatiaRules = {
  year: 2026,
  checked_on: "2026-11-24",
  profit_tax: { lower: "0.10", higher: "0.18", revenue_threshold: "1000000" },
  dividend_tax: "0.12",
  capital_gains: { rate: "0.12", exempt_after_years: 2 },
  employee: { pension_1: "0.15", pension_2: "0.05", health: "0.165" },
  self_employed: { pension: "0.20", health: "0.165", min_base_monthly: "1295.45" },
  // 6 x the 2026 average wage of 1,993.00 that also sets the minimum base (0.65 x 1,993.00).
  max_base_monthly: "11958.00",
  personal_allowance_monthly: "600",
  bracket_annual: "60000",
  city_rates: { city: "Zagreb", lower: "0.23", higher: "0.33" },
  pillar3: { incentive_rate: "0.15", incentive_cap_contribution: "663.61" },
  cross_border: {
    us_treaty_in_force: false,
    us_withholding: "0.30",
    ireland_fund_us_withholding: "0.15",
    other_fund_us_withholding: "0.30",
    us_estate_exemption_usd: "60000",
  },
  sources: [
    {
      what: "Profit tax 10% up to EUR 1,000,000 of revenue, 18% above",
      url: "https://porezna-uprava.gov.hr/hr/porez-na-dobit-3940/3940",
    },
    {
      what: "Dividends and capital gains 12%, final; gains exempt after 2 years",
      url: "https://porezna-uprava.gov.hr/hr/oporezivanje-kapitala/4745",
    },
    {
      what: "Zagreb income tax 23% up to EUR 60,000 a year, 33% above (NN 28/2025)",
      url: "https://narodne-novine.nn.hr/clanci/sluzbeni/2025_02_28_291.html",
    },
    {
      what: "City rate ranges and the personal allowance",
      url: "https://porezna-uprava.gov.hr/hr/porezne-stope-godisnjeg-poreza-na-dohodak/4764",
    },
    {
      what: "III. stup: 15% state incentive on up to EUR 663.61 a year (EUR 99.54)",
      url: "https://www.hanfa.hr/media/fuyi5v2h/dobrovoljna-mirovinska-štednja-8.pdf",
    },
    {
      what: "US-Croatia income tax treaty: signed 2022, protocol 2026, not yet in force",
      url: "https://home.treasury.gov/system/files/131/Treaty-Croatia-Protocol-04-28-2026.pdf",
    },
  ],
};

export const RULES_BY_YEAR: Record<number, CroatiaRules> = { 2026: HR_RULES_2026 };

/** The rules for a tax year: that year's when known, else the newest, with a warning. */
export function rulesFor(year: number, warnings: string[]): CroatiaRules {
  const known = RULES_BY_YEAR[year];
  if (known) return known;
  const newest = Math.max(...Object.keys(RULES_BY_YEAR).map(Number));
  warnings.push(
    `Tidysum has Croatian rules for ${newest}, not ${year}; ${newest}'s are used. The contribution ` +
      "bases change every January: check them and override them in the facts file.",
  );
  return RULES_BY_YEAR[newest] as CroatiaRules;
}
