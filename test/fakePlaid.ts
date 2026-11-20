import type {
  PlaidAccount,
  PlaidGateway,
  PlaidHolding,
  PlaidItemInfo,
  PlaidLiability,
  PlaidSecurity,
  PlaidTransaction,
  TransactionsPage,
  WebhookVerificationKey,
} from "../src/plaid/gateway.js";
import { PlaidApiError } from "../src/plaid/gateway.js";

type PageOrError = TransactionsPage | PlaidApiError;

/** Scripted Plaid: transaction pages are served per cursor, in order. */
export class FakePlaid implements PlaidGateway {
  accounts: PlaidAccount[] = [];
  pagesByCursor = new Map<string, PageOrError[]>();
  holdings: { holdings: PlaidHolding[]; securities: PlaidSecurity[] } | PlaidApiError =
    new PlaidApiError("INVALID_REQUEST", "NO_INVESTMENT_ACCOUNTS", "none");
  liabilities: PlaidLiability[] | PlaidApiError = new PlaidApiError(
    "INVALID_REQUEST",
    "NO_LIABILITY_ACCOUNTS",
    "none",
  );
  accountsError: PlaidApiError | undefined;
  syncCalls: (string | null)[] = [];
  removed: string[] = [];

  constructor(readonly info: PlaidItemInfo = fakeItemInfo) {}

  /** Queue the response for the next sync call made with `cursor`. */
  onSync(cursor: string | null, response: PageOrError) {
    const key = cursor ?? "";
    this.pagesByCursor.set(key, [...(this.pagesByCursor.get(key) ?? []), response]);
  }

  async exchangePublicToken(publicToken: string) {
    // "public-1" is the default Item; any other token is an Item of its own.
    const itemId = publicToken === "public-1" ? this.info.itemId : `plaid-${publicToken}`;
    return { accessToken: `access-${publicToken}`, itemId };
  }
  async getItem() {
    return this.info;
  }
  async getAccounts() {
    if (this.accountsError) throw this.accountsError;
    return this.accounts;
  }
  async syncTransactions(_token: string, cursor: string | null) {
    this.syncCalls.push(cursor);
    const queue = this.pagesByCursor.get(cursor ?? "");
    const next = queue?.shift();
    if (!next) throw new Error(`no scripted page for cursor ${cursor}`);
    if (next instanceof PlaidApiError) throw next;
    return next;
  }
  async removeItem(accessToken: string) {
    this.removed.push(accessToken);
  }
  async getHoldings() {
    if (this.holdings instanceof PlaidApiError) throw this.holdings;
    return this.holdings;
  }
  async getLiabilities() {
    if (this.liabilities instanceof PlaidApiError) throw this.liabilities;
    return this.liabilities;
  }
  async createSandboxPublicToken() {
    return "public-sandbox";
  }
  linkTokenRequests: {
    clientUserId: string;
    accessToken?: string;
    plaidUserId?: string;
    phoneNumber?: string;
    webhookUrl?: string;
    daysRequested: number;
    countryCodes: string[];
  }[] = [];
  async createLinkToken(options: {
    clientUserId: string;
    accessToken?: string;
    plaidUserId?: string;
    phoneNumber?: string;
    webhookUrl?: string;
    daysRequested: number;
    countryCodes: string[];
  }) {
    this.linkTokenRequests.push(options);
    return `link-token-${this.linkTokenRequests.length}`;
  }
  createdUsers: string[] = [];
  /** Set to make /user/create fail, as it would for an account without the user APIs. */
  userCreateError: Error | undefined;
  async createUser(clientUserId: string) {
    if (this.userCreateError) throw this.userCreateError;
    this.createdUsers.push(clientUserId);
    return `plaid-user-${this.createdUsers.length}`;
  }
  /** Public tokens each finished Link session added, by link token. */
  linkSessionTokens = new Map<string, string[]>();
  async getLinkSessionPublicTokens(linkToken: string) {
    return this.linkSessionTokens.get(linkToken) ?? [];
  }
  webhookKeys = new Map<string, WebhookVerificationKey>();
  async getWebhookVerificationKey(keyId: string) {
    const key = this.webhookKeys.get(keyId);
    if (!key)
      throw new PlaidApiError("INVALID_INPUT", "INVALID_WEBHOOK_VERIFICATION_KEY_ID", keyId);
    return key;
  }
}

export const fakeItemInfo: PlaidItemInfo = {
  itemId: "plaid-item-1",
  institutionId: "ins_109508",
  institutionName: "First Platypus Bank",
};

export function checking(current: string): PlaidAccount {
  return {
    accountId: "acc-checking",
    name: "Plaid Checking",
    officialName: null,
    type: "depository",
    subtype: "checking",
    mask: "0000",
    currency: "USD",
    balances: { current, available: current, limit: null },
  };
}

export function txn(id: string, amount: string, extra: Partial<PlaidTransaction> = {}) {
  return {
    transactionId: id,
    accountId: "acc-checking",
    date: "2026-10-01",
    authorizedDate: null,
    amount,
    currency: "USD",
    name: `merchant ${id}`,
    merchantName: null,
    categoryPrimary: null,
    categoryDetailed: null,
    pending: false,
    pendingTransactionId: null,
    ...extra,
  } satisfies PlaidTransaction;
}

export function page(p: Partial<TransactionsPage> & { nextCursor: string }): TransactionsPage {
  return { accounts: [], added: [], modified: [], removed: [], hasMore: false, ...p };
}
