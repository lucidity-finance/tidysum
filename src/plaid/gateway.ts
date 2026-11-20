/**
 * The slice of Plaid that Tidysum uses, in Tidysum's own shapes. Money and quantities are
 * decimal strings. Only the ingest side ever constructs one of these; agents never do.
 */

export interface PlaidAccount {
  accountId: string;
  name: string;
  officialName: string | null;
  type: string;
  subtype: string | null;
  mask: string | null;
  currency: string | null;
  balances: {
    current: string | null;
    available: string | null;
    limit: string | null;
  };
}

export interface PlaidTransaction {
  transactionId: string;
  accountId: string;
  date: string;
  authorizedDate: string | null;
  amount: string;
  currency: string | null;
  name: string | null;
  merchantName: string | null;
  categoryPrimary: string | null;
  categoryDetailed: string | null;
  pending: boolean;
  pendingTransactionId: string | null;
}

export interface TransactionsPage {
  accounts: PlaidAccount[];
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: { transactionId: string }[];
  nextCursor: string;
  hasMore: boolean;
}

export interface PlaidSecurity {
  securityId: string;
  name: string | null;
  tickerSymbol: string | null;
  type: string | null;
  isCashEquivalent: boolean | null;
  closePrice: string | null;
  closePriceAsOf: string | null;
  currency: string | null;
}

export interface PlaidHolding {
  accountId: string;
  securityId: string;
  quantity: string;
  institutionPrice: string;
  institutionValue: string;
  costBasis: string | null;
  currency: string | null;
}

export interface PlaidLiability {
  accountId: string;
  kind: "credit" | "mortgage" | "student";
  aprPercentage: string | null;
  lastStatementBalance: string | null;
  minimumPayment: string | null;
  nextPaymentDueDate: string | null;
  isOverdue: boolean | null;
}

export interface PlaidItemInfo {
  itemId: string;
  institutionId: string | null;
  institutionName: string | null;
}

/** What a sync reads from a connection: Plaid's, or another source in Plaid's shapes. */
export type SyncGateway = Pick<
  PlaidGateway,
  "getAccounts" | "syncTransactions" | "getHoldings" | "getLiabilities" | "removeItem"
>;

export interface PlaidGateway {
  exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }>;
  getItem(accessToken: string): Promise<PlaidItemInfo>;
  /** Real-time balances via /accounts/balance/get. Rate limited per Item; call on a schedule. */
  getAccounts(accessToken: string): Promise<PlaidAccount[]>;
  syncTransactions(accessToken: string, cursor: string | null): Promise<TransactionsPage>;
  getHoldings(
    accessToken: string,
  ): Promise<{ holdings: PlaidHolding[]; securities: PlaidSecurity[] }>;
  getLiabilities(accessToken: string): Promise<PlaidLiability[]>;
  /** Revokes the access token at Plaid (/item/remove). Plaid stops billing for the Item. */
  removeItem(accessToken: string): Promise<void>;
  createSandboxPublicToken(institutionId: string, daysRequested: number): Promise<string>;
  /**
   * A Link token for the browser. With `accessToken` it opens Link in update mode to repair
   * an existing Item; without it, Link adds a new Item.
   */
  createLinkToken(options: {
    /** Plaid's client_user_id: the Tidysum user id, stable per person. */
    clientUserId: string;
    /** ISO country codes Link offers institutions from (src/region.ts plaidCountries). */
    countryCodes: string[];
    accessToken?: string;
    /**
     * Plaid's user id from createUser. With it, a new-Item Link session can add several
     * institutions in a row (Multi-Item Link); the Items come back from getLinkSessionPublicTokens.
     */
    plaidUserId?: string;
    /**
     * The person's phone number, E.164. Link pre-fills it for a returning user, who then only
     * types the code Plaid texts instead of the number as well.
     */
    phoneNumber?: string;
    webhookUrl?: string;
    daysRequested: number;
  }): Promise<string>;
  /** Registers the person with Plaid (/user/create) and returns Plaid's user id. */
  createUser(clientUserId: string): Promise<string>;
  /** The public token of every Item a finished Multi-Item Link session added (/link/token/get). */
  getLinkSessionPublicTokens(linkToken: string): Promise<string[]>;
  /** The public key Plaid signed a webhook with, as a JWK. */
  getWebhookVerificationKey(keyId: string): Promise<WebhookVerificationKey>;
}

export interface WebhookVerificationKey {
  jwk: { kty: string; crv: string; x: string; y: string; kid: string; alg: string };
  expiredAt: number | null;
}

export class PlaidApiError extends Error {
  constructor(
    readonly errorType: string,
    readonly errorCode: string,
    message: string,
    /** The Plaid endpoint that failed, such as /accounts/balance/get, when known. */
    readonly endpoint?: string,
  ) {
    super(`${errorType}/${errorCode}${endpoint ? ` from ${endpoint}` : ""}: ${message}`);
    this.name = "PlaidApiError";
  }
}

/** Errors that mean the user has to re-link the Item through Plaid Link (update mode). */
export const RELINK_ERROR_CODES = new Set([
  "ITEM_LOGIN_REQUIRED",
  "PENDING_EXPIRATION",
  "PENDING_DISCONNECT",
  "ACCESS_NOT_GRANTED",
  "INSUFFICIENT_CREDENTIALS",
  "USER_PERMISSION_REVOKED",
]);

/** Errors that mean "this Item has no data for this product", not a failure. */
export const PRODUCT_ABSENT_ERROR_CODES = new Set([
  "PRODUCTS_NOT_SUPPORTED",
  "PRODUCT_NOT_ENABLED",
  "NO_INVESTMENT_ACCOUNTS",
  "NO_INVESTMENT_AUTH_ACCOUNTS",
  "NO_LIABILITY_ACCOUNTS",
  "INVALID_PRODUCT",
]);

/**
 * Errors from Plaid's live balance check that mean the bank (or Plaid) couldn't answer just
 * now. The balances Plaid pulled on its own last refresh still hold, so the sync uses those.
 */
export const LIVE_BALANCE_UNAVAILABLE_CODES = new Set([
  "INTERNAL_SERVER_ERROR",
  "PLAID_ERROR",
  "INSTITUTION_DOWN",
  "INSTITUTION_NOT_RESPONDING",
  "INSTITUTION_NOT_AVAILABLE",
  "BALANCE_LIMIT",
]);

export const MUTATION_DURING_PAGINATION = "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION";
