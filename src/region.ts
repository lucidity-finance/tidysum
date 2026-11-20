import Big from "big.js";

// Where a user lives decides their currency, which banks can be linked, and which advice applies.
// Tidysum began in the US, so much of it is US-only: the 401(k) and IRA rules, the SEC, CFPB and
// Treasury data, and the bank and card catalogs. Those parts switch off for users elsewhere rather
// than give advice that doesn't hold there (docs/decisions/0011-countries.md).

export interface Country {
  name: string;
  /** ISO 4217 code of the money a user here is paid in and counts in. */
  currency: string;
  /** "eu" for EU members: Plaid's Europe coverage and the EU deposit guarantee. */
  region: "us" | "ca" | "uk" | "eu";
}

const eu = (name: string, currency = "EUR"): Country => ({ name, currency, region: "eu" });

/** The countries Tidysum knows, by ISO 3166-1 alpha-2 code. */
export const COUNTRIES = {
  US: { name: "United States", currency: "USD", region: "us" },
  CA: { name: "Canada", currency: "CAD", region: "ca" },
  GB: { name: "United Kingdom", currency: "GBP", region: "uk" },
  AT: eu("Austria"),
  BE: eu("Belgium"),
  BG: eu("Bulgaria"),
  HR: eu("Croatia"),
  CY: eu("Cyprus"),
  CZ: eu("Czechia", "CZK"),
  DK: eu("Denmark", "DKK"),
  EE: eu("Estonia"),
  FI: eu("Finland"),
  FR: eu("France"),
  DE: eu("Germany"),
  GR: eu("Greece"),
  HU: eu("Hungary", "HUF"),
  IE: eu("Ireland"),
  IT: eu("Italy"),
  LV: eu("Latvia"),
  LT: eu("Lithuania"),
  LU: eu("Luxembourg"),
  MT: eu("Malta"),
  NL: eu("Netherlands"),
  PL: eu("Poland", "PLN"),
  PT: eu("Portugal"),
  RO: eu("Romania", "RON"),
  SK: eu("Slovakia"),
  SI: eu("Slovenia"),
  ES: eu("Spain"),
  SE: eu("Sweden", "SEK"),
} as const satisfies Record<string, Country>;

export type CountryCode = keyof typeof COUNTRIES;
export const COUNTRY_CODES = Object.keys(COUNTRIES) as CountryCode[];

export function isCountryCode(s: string): s is CountryCode {
  return Object.hasOwn(COUNTRIES, s);
}

/** A user's country and home currency, the pair most code needs. */
export interface Region {
  country: CountryCode;
  currency: string;
}

export function regionOf(country: string | null | undefined): Region {
  const code = (country ?? "US").toUpperCase();
  if (!isCountryCode(code)) throw new Error(`unknown country ${country}`);
  return { country: code, currency: COUNTRIES[code].currency };
}

export const US: Region = regionOf("US");

/**
 * What Tidysum can do for a user in this country. US-only parts are named for what they need:
 * US tax law (401(k), IRA), US government data (SEC, CFPB, Treasury), and the catalogs, which
 * list US banks and cards only.
 */
export function features(region: Region) {
  const us = region.country === "US";
  return {
    /** 401(k), IRA and backdoor Roth checks: US tax law. */
    usRetirement: us,
    /** SEC fund fees, CFPB card terms and the Treasury bill yield: US government data. */
    usPublicFacts: us,
  };
}

/** Plaid's free Trial plan reaches US and Canadian institutions only (docs/connect-your-accounts.md). */
export const PLAID_TRIAL_COUNTRIES = ["US", "CA"] as const;

/**
 * The Plaid Europe countries, for a Plaid team that has been through Plaid's European production
 * review (PLAID_EUROPE=true). Plaid's own list, which is narrower than the EU.
 */
export const PLAID_EUROPE_COUNTRIES = [
  "GB",
  "AT",
  "BE",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "IE",
  "IT",
  "LV",
  "LT",
  "NL",
  "PL",
  "PT",
  "ES",
  "SE",
] as const;

/**
 * The country codes a Plaid Link session offers banks from, own country first, or a reason it
 * can't. US and Canadian users see both, since people in either often bank in the other.
 */
export function plaidCountries(
  region: Region,
  europeEnabled: boolean,
): { codes: string[] } | { unavailable: string } {
  const c = region.country;
  if (c === "US") return { codes: ["US", "CA"] };
  if (c === "CA") return { codes: ["CA", "US"] };
  if ((PLAID_EUROPE_COUNTRIES as readonly string[]).includes(c) && europeEnabled) {
    return { codes: [c] };
  }
  return {
    unavailable:
      `Plaid's free plan only connects US and Canadian banks, so accounts in ${COUNTRIES[c].name} ` +
      "can't be linked through it. Import them from a CSV export instead (`tidysum import-csv`). " +
      "If your Plaid team has Plaid's European production access, set PLAID_EUROPE=true.",
  };
}

const SYMBOLS: Record<string, string> = { USD: "$", CAD: "$", GBP: "£", EUR: "€" };

/**
 * How an amount is written: the symbol of the user's own currency ("$1,234", "£1,234", "€1,234"),
 * or for any other currency its code as well ("US$1,234", "CA$1,234", "PLN 1,234"), so two
 * currencies sharing a "$" never read alike.
 */
export function currencyPrefix(currency: string, home: string): string {
  const symbol = SYMBOLS[currency];
  if (currency === home && symbol) return symbol;
  if (symbol === "$") return `${currency.slice(0, 2)}$`;
  if (symbol) return symbol;
  return `${currency} `;
}

const groups = (whole: string) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** "$1,234" (whole units, half up) from a decimal string, in `currency` as seen from `home`. */
export function formatMoney(
  s: string | number | null | undefined,
  currency: string,
  home: string = currency,
): string {
  const b = new Big(s ?? 0).round(0, Big.roundHalfUp);
  const sign = b.lt(0) ? "-" : "";
  return `${sign}${currencyPrefix(currency, home)}${groups(b.abs().toFixed(0))}`;
}
