// SimpleFIN sends no categories, but Tidysum's checks read Plaid's (card rewards by category,
// interest earned, card interest and fees, transfers that would count twice as spending). This
// gives a SimpleFIN transaction the Plaid category it would most likely have had: from the
// merchant category code when SimpleFIN Bridge sends one (card networks assign it, and card
// rewards are defined by it), else from a few unmistakable descriptions. Anything unclear stays
// uncategorised, which Tidysum treats as everyday spending, as it does Plaid's "other".

export interface Category {
  primary: string;
  detailed: string;
}

const cat = (detailed: string, primary: string): Category => ({ primary, detailed });

const GROCERIES = cat("FOOD_AND_DRINK_GROCERIES", "FOOD_AND_DRINK");
const RESTAURANT = cat("FOOD_AND_DRINK_RESTAURANT", "FOOD_AND_DRINK");
const FAST_FOOD = cat("FOOD_AND_DRINK_FAST_FOOD", "FOOD_AND_DRINK");
const GAS = cat("TRANSPORTATION_GAS", "TRANSPORTATION");
const TRANSIT = cat("TRANSPORTATION_PUBLIC_TRANSIT", "TRANSPORTATION");
const RIDES = cat("TRANSPORTATION_TAXIS_AND_RIDE_SHARES", "TRANSPORTATION");
const PARKING = cat("TRANSPORTATION_PARKING", "TRANSPORTATION");
const TOLLS = cat("TRANSPORTATION_TOLLS", "TRANSPORTATION");
const FLIGHTS = cat("TRAVEL_FLIGHTS", "TRAVEL");
const LODGING = cat("TRAVEL_LODGING", "TRAVEL");
const RENTAL_CARS = cat("TRAVEL_RENTAL_CARS", "TRAVEL");
const OTHER_TRAVEL = cat("TRAVEL_OTHER_TRAVEL", "TRAVEL");
const TV = cat("ENTERTAINMENT_TV_AND_MOVIES", "ENTERTAINMENT");
const GAMES = cat("ENTERTAINMENT_VIDEO_GAMES", "ENTERTAINMENT");
const EVENTS = cat("ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS", "ENTERTAINMENT");
const PHARMACY = cat("MEDICAL_PHARMACIES_AND_SUPPLEMENTS", "MEDICAL");
const CLOTHING = cat("GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES", "GENERAL_MERCHANDISE");
const UTILITIES = cat("RENT_AND_UTILITIES_GAS_AND_ELECTRICITY", "RENT_AND_UTILITIES");
const RENT = cat("RENT_AND_UTILITIES_RENT", "RENT_AND_UTILITIES");
const TAXES = cat("GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT", "GOVERNMENT_AND_NON_PROFIT");
const DONATIONS = cat("GOVERNMENT_AND_NON_PROFIT_DONATIONS", "GOVERNMENT_AND_NON_PROFIT");

/** Merchant category codes (ISO 18245) as card issuers use them for bonus categories. */
const MCC: Record<string, Category> = {
  "5411": GROCERIES,
  "5812": RESTAURANT,
  "5813": RESTAURANT,
  "5814": FAST_FOOD,
  "5541": GAS,
  "5542": GAS,
  "4111": TRANSIT,
  "4112": TRANSIT,
  "4131": TRANSIT,
  "4121": RIDES,
  "7523": PARKING,
  "4784": TOLLS,
  "4511": FLIGHTS,
  "7011": LODGING,
  "7512": RENTAL_CARS,
  "4722": OTHER_TRAVEL,
  "4411": OTHER_TRAVEL,
  "4899": TV,
  "5815": TV,
  "7832": TV,
  "5816": GAMES,
  "7922": EVENTS,
  "7941": EVENTS,
  "7991": EVENTS,
  "7996": EVENTS,
  "5912": PHARMACY,
  "5611": CLOTHING,
  "5621": CLOTHING,
  "5631": CLOTHING,
  "5641": CLOTHING,
  "5651": CLOTHING,
  "5655": CLOTHING,
  "5661": CLOTHING,
  "5691": CLOTHING,
  "5699": CLOTHING,
  "4900": UTILITIES,
  "6513": RENT,
  "9311": TAXES,
  "8398": DONATIONS,
  "8661": DONATIONS,
};

/** Airline (3000-3299), car rental (3351-3441) and hotel (3501-3999) codes, by brand. */
function mccRange(code: number): Category | null {
  if (code >= 3000 && code <= 3299) return FLIGHTS;
  if (code >= 3351 && code <= 3441) return RENTAL_CARS;
  if (code >= 3501 && code <= 3999) return LODGING;
  return null;
}

export interface CategoryInput {
  mcc?: string | null | undefined;
  /** Description, payee and memo together. */
  text: string;
  /** True for money leaving the account. */
  out: boolean;
  /** The account's kind, as the sync stores it. */
  accountType: string;
}

const has = (re: RegExp, s: string) => re.test(s);

/** The Plaid category Tidysum would have seen, or null when it isn't clear. */
export function categorize({ mcc, text, out, accountType }: CategoryInput): Category | null {
  const s = text.toLowerCase();
  const card = accountType === "credit";

  // Descriptions first for the money that isn't spending, whatever its code says.
  if (card && !out && has(/\b(payment|autopay|pymt|thank you)\b/, s)) {
    return cat("LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", "LOAN_PAYMENTS");
  }
  if (
    !card &&
    out &&
    has(/\b(card|credit crd|crd|epay|autopay|autopymt)\b.*\b(payment|pymt|pmt|autopay)\b/, s)
  ) {
    return cat("LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", "LOAN_PAYMENTS");
  }
  if (has(/\b(interest charge|purchase interest|finance charge)\b/, s) && out) {
    return cat("BANK_FEES_INTEREST_CHARGE", "BANK_FEES");
  }
  if (has(/\bforeign (transaction|trans|txn|currency) fee\b|\bintl? (transaction )?fee\b/, s)) {
    return cat("BANK_FEES_FOREIGN_TRANSACTION_FEES", "BANK_FEES");
  }
  if (!out && !card && has(/\binterest (paid|earned|payment|credit)\b|^interest$/, s)) {
    return cat("INCOME_INTEREST_EARNED", "INCOME");
  }
  if (!out && has(/\bdividends?\b/, s)) return cat("INCOME_DIVIDENDS", "INCOME");
  if (out && has(/\b(overdraft|nsf|insufficient funds)\b/, s)) {
    return cat("BANK_FEES_OVERDRAFT_FEES", "BANK_FEES");
  }
  if (
    out &&
    has(/\b(monthly (service|maintenance) (fee|charge)|service charge|maintenance fee)\b/, s)
  ) {
    return cat("BANK_FEES_OTHER_BANK_FEES", "BANK_FEES");
  }
  if (!out && has(/\b(payroll|direct dep|salary)\b/, s)) return cat("INCOME_WAGES", "INCOME");
  if (has(/\b(transfer|xfer)\b/, s)) {
    return out
      ? cat("TRANSFER_OUT_ACCOUNT_TRANSFER", "TRANSFER_OUT")
      : cat("TRANSFER_IN_ACCOUNT_TRANSFER", "TRANSFER_IN");
  }

  if (out && mcc && /^\d{4}$/.test(mcc)) {
    return MCC[mcc] ?? mccRange(Number(mcc));
  }
  return null;
}
