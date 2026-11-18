import {
  type AccountBase,
  Configuration,
  CountryCode,
  PlaidApi,
  PlaidEnvironments,
  Products,
  type Transaction,
} from "plaid";
import type { PlaidConfig } from "../config.js";
import {
  type PlaidAccount,
  PlaidApiError,
  type PlaidGateway,
  type PlaidHolding,
  type PlaidLiability,
  type PlaidTransaction,
} from "./gateway.js";

/** Plaid's JSON numbers become decimal strings at the edge; String() keeps the shortest exact form. */
const dec = (n: number | null | undefined): string | null => (n == null ? null : String(n));
const decReq = (n: number): string => String(n);

function mapAccount(a: AccountBase): PlaidAccount {
  return {
    accountId: a.account_id,
    name: a.name,
    officialName: a.official_name,
    type: a.type,
    subtype: a.subtype,
    mask: a.mask,
    currency: a.balances.iso_currency_code ?? a.balances.unofficial_currency_code,
    balances: {
      current: dec(a.balances.current),
      available: dec(a.balances.available),
      limit: dec(a.balances.limit),
    },
  };
}

function mapTransaction(t: Transaction): PlaidTransaction {
  return {
    transactionId: t.transaction_id,
    accountId: t.account_id,
    date: t.date,
    authorizedDate: t.authorized_date,
    amount: decReq(t.amount),
    currency: t.iso_currency_code ?? t.unofficial_currency_code,
    name: t.name,
    merchantName: t.merchant_name ?? null,
    categoryPrimary: t.personal_finance_category?.primary ?? null,
    categoryDetailed: t.personal_finance_category?.detailed ?? null,
    pending: t.pending,
    pendingTransactionId: t.pending_transaction_id,
  };
}

async function call<T>(fn: () => Promise<{ data: T }>): Promise<T> {
  try {
    return (await fn()).data;
  } catch (err) {
    // The Plaid client throws axios errors; the Plaid error body is on response.data.
    const d = (err as { response?: { data?: Record<string, string> } }).response?.data;
    if (d?.error_code) {
      throw new PlaidApiError(d.error_type ?? "UNKNOWN", d.error_code, d.error_message ?? "");
    }
    throw err;
  }
}

export class PlaidApiGateway implements PlaidGateway {
  private readonly api: PlaidApi;

  constructor(config: PlaidConfig) {
    this.api = new PlaidApi(
      new Configuration({
        basePath: PlaidEnvironments[config.PLAID_ENV],
        baseOptions: {
          headers: {
            "PLAID-CLIENT-ID": config.PLAID_CLIENT_ID,
            "PLAID-SECRET": config.PLAID_SECRET,
          },
        },
      }),
    );
  }

  async exchangePublicToken(publicToken: string) {
    const r = await call(() => this.api.itemPublicTokenExchange({ public_token: publicToken }));
    return { accessToken: r.access_token, itemId: r.item_id };
  }

  async getItem(accessToken: string) {
    const r = await call(() => this.api.itemGet({ access_token: accessToken }));
    const institutionId = r.item.institution_id ?? null;
    let institutionName = r.item.institution_name ?? null;
    if (institutionId && !institutionName) {
      const inst = await call(() =>
        this.api.institutionsGetById({
          institution_id: institutionId,
          country_codes: [CountryCode.Us],
        }),
      );
      institutionName = inst.institution.name;
    }
    return { itemId: r.item.item_id, institutionId, institutionName };
  }

  async getAccounts(accessToken: string) {
    const r = await call(() => this.api.accountsBalanceGet({ access_token: accessToken }));
    return r.accounts.map(mapAccount);
  }

  async syncTransactions(accessToken: string, cursor: string | null) {
    const r = await call(() =>
      this.api.transactionsSync({
        access_token: accessToken,
        ...(cursor ? { cursor } : {}),
        count: 500,
      }),
    );
    return {
      accounts: r.accounts.map(mapAccount),
      added: r.added.map(mapTransaction),
      modified: r.modified.map(mapTransaction),
      removed: r.removed.map((x) => ({ transactionId: x.transaction_id })),
      nextCursor: r.next_cursor,
      hasMore: r.has_more,
    };
  }

  async getHoldings(accessToken: string) {
    const r = await call(() => this.api.investmentsHoldingsGet({ access_token: accessToken }));
    return {
      holdings: r.holdings.map(
        (h): PlaidHolding => ({
          accountId: h.account_id,
          securityId: h.security_id,
          quantity: decReq(h.quantity),
          institutionPrice: decReq(h.institution_price),
          institutionValue: decReq(h.institution_value),
          costBasis: dec(h.cost_basis),
          currency: h.iso_currency_code ?? h.unofficial_currency_code,
        }),
      ),
      securities: r.securities.map((s) => ({
        securityId: s.security_id,
        name: s.name,
        tickerSymbol: s.ticker_symbol,
        type: s.type,
        isCashEquivalent: s.is_cash_equivalent,
        closePrice: dec(s.close_price),
        closePriceAsOf: s.close_price_as_of,
        currency: s.iso_currency_code ?? s.unofficial_currency_code,
      })),
    };
  }

  async removeItem(accessToken: string) {
    await call(() => this.api.itemRemove({ access_token: accessToken }));
  }

  async getLiabilities(accessToken: string) {
    const r = await call(() => this.api.liabilitiesGet({ access_token: accessToken }));
    const out: PlaidLiability[] = [];
    for (const c of r.liabilities.credit ?? []) {
      if (!c.account_id) continue;
      const purchase = c.aprs.find((a) => a.apr_type === "purchase_apr") ?? c.aprs[0];
      out.push({
        accountId: c.account_id,
        kind: "credit",
        aprPercentage: dec(purchase?.apr_percentage),
        lastStatementBalance: dec(c.last_statement_balance),
        minimumPayment: dec(c.minimum_payment_amount),
        nextPaymentDueDate: c.next_payment_due_date,
        isOverdue: c.is_overdue,
      });
    }
    for (const m of r.liabilities.mortgage ?? []) {
      out.push({
        accountId: m.account_id,
        kind: "mortgage",
        aprPercentage: dec(m.interest_rate.percentage),
        lastStatementBalance: null,
        minimumPayment: dec(m.next_monthly_payment),
        nextPaymentDueDate: m.next_payment_due_date,
        isOverdue: m.past_due_amount != null ? m.past_due_amount > 0 : null,
      });
    }
    for (const s of r.liabilities.student ?? []) {
      if (!s.account_id) continue;
      out.push({
        accountId: s.account_id,
        kind: "student",
        aprPercentage: dec(s.interest_rate_percentage),
        lastStatementBalance: dec(s.last_statement_balance),
        minimumPayment: dec(s.minimum_payment_amount),
        nextPaymentDueDate: s.next_payment_due_date,
        isOverdue: s.is_overdue,
      });
    }
    return out;
  }

  async createSandboxPublicToken(institutionId: string, daysRequested: number) {
    const r = await call(() =>
      this.api.sandboxPublicTokenCreate({
        institution_id: institutionId,
        initial_products: [Products.Transactions],
        options: { transactions: { days_requested: daysRequested } },
      }),
    );
    return r.public_token;
  }

  async createLinkToken(options: {
    clientUserId: string;
    accessToken?: string;
    plaidUserId?: string;
    phoneNumber?: string;
    webhookUrl?: string;
    daysRequested: number;
  }) {
    const base = {
      client_name: "Tidysum",
      language: "en",
      country_codes: [CountryCode.Us],
      user: {
        client_user_id: options.clientUserId,
        ...(options.phoneNumber ? { phone_number: options.phoneNumber } : {}),
      },
      ...(options.webhookUrl ? { webhook: options.webhookUrl } : {}),
    };
    const request = options.accessToken
      ? { ...base, access_token: options.accessToken }
      : {
          ...base,
          products: [Products.Transactions],
          optional_products: [Products.Investments, Products.Liabilities],
          transactions: { days_requested: options.daysRequested },
          ...(options.plaidUserId
            ? { enable_multi_item_link: true, user_id: options.plaidUserId }
            : {}),
        };
    const r = await call(() => this.api.linkTokenCreate(request));
    return r.link_token;
  }

  async createUser(clientUserId: string) {
    const r = await call(() => this.api.userCreate({ client_user_id: clientUserId }));
    // Integrations from before December 2025 get a user_token instead, which Tidysum doesn't use.
    if (!r.user_id) throw new Error("Plaid /user/create returned no user_id");
    return r.user_id;
  }

  async getLinkSessionPublicTokens(linkToken: string) {
    const r = await call(() => this.api.linkTokenGet({ link_token: linkToken }));
    return (r.link_sessions ?? []).flatMap((s) =>
      (s.results?.item_add_results ?? []).map((i) => i.public_token),
    );
  }

  async getWebhookVerificationKey(keyId: string) {
    const r = await call(() => this.api.webhookVerificationKeyGet({ key_id: keyId }));
    const { kty, crv, x, y, kid, alg } = r.key;
    return { jwk: { kty, crv, x, y, kid, alg }, expiredAt: r.key.expired_at };
  }
}
