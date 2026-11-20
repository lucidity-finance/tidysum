import {
  PlaidApiError,
  type PlaidGateway,
  type PlaidItemInfo,
  type WebhookVerificationKey,
} from "../plaid/gateway.js";
import type { DemoHousehold, DemoInstitution } from "./household.js";

/**
 * Plaid for `tidysum demo`: serves the demo household instead of calling Plaid, so the demo
 * runs the real sync, detectors and pages with no Plaid account or keys. Linking a real bank is
 * refused: the demo is never mixed with real data.
 */
export class DemoPlaid implements PlaidGateway {
  constructor(private readonly household: DemoHousehold) {}

  private institution(token: string): DemoInstitution {
    const found = this.household.institutions.find((i) => i.token === token);
    if (!found) throw new PlaidApiError("INVALID_INPUT", "INVALID_ACCESS_TOKEN", "not a demo bank");
    return found;
  }

  async exchangePublicToken(publicToken: string) {
    const i = this.institution(publicToken);
    return { accessToken: i.token, itemId: i.itemId };
  }

  async getItem(accessToken: string): Promise<PlaidItemInfo> {
    const i = this.institution(accessToken);
    return { itemId: i.itemId, institutionId: i.institutionId, institutionName: i.name };
  }

  async getAccounts(accessToken: string) {
    return this.institution(accessToken).accounts;
  }

  async syncTransactions(accessToken: string, cursor: string | null) {
    const i = this.institution(accessToken);
    // Everything arrives on the first sync; later syncs find nothing new.
    return {
      accounts: i.accounts,
      added: cursor ? [] : i.transactions,
      modified: [],
      removed: [],
      nextCursor: `demo-${this.household.today}`,
      hasMore: false,
    };
  }

  async getHoldings(accessToken: string) {
    const i = this.institution(accessToken);
    if (i.holdings.length === 0) {
      throw new PlaidApiError("INVALID_REQUEST", "NO_INVESTMENT_ACCOUNTS", "no investments");
    }
    return { holdings: i.holdings, securities: i.securities };
  }

  async getLiabilities(accessToken: string) {
    const i = this.institution(accessToken);
    if (i.liabilities.length === 0) {
      throw new PlaidApiError("INVALID_REQUEST", "NO_LIABILITY_ACCOUNTS", "no liabilities");
    }
    return i.liabilities;
  }

  async removeItem() {}

  private refuse(): never {
    throw new PlaidApiError(
      "INVALID_REQUEST",
      "DEMO_MODE",
      "This is the demo with a made-up person; it can't link real accounts. Run Tidysum without `demo` to connect yours.",
    );
  }

  async createSandboxPublicToken(): Promise<string> {
    return this.refuse();
  }
  async createLinkToken(): Promise<string> {
    return this.refuse();
  }
  async createUser(): Promise<string> {
    return this.refuse();
  }
  async getLinkSessionPublicTokens(): Promise<string[]> {
    return this.refuse();
  }
  async getWebhookVerificationKey(): Promise<WebhookVerificationKey> {
    return this.refuse();
  }
}
