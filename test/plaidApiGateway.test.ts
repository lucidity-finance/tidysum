import { describe, expect, it } from "vitest";
import { PlaidApiError } from "../src/plaid/gateway.js";
import { PlaidApiGateway } from "../src/plaid/plaidApiGateway.js";

const account = (current: number) => ({
  account_id: "acc-1",
  name: "Brokerage",
  official_name: null,
  type: "investment",
  subtype: "brokerage",
  mask: "0041",
  balances: { current, available: null, limit: null, iso_currency_code: "USD" },
});

/** What the Plaid client throws: an axios error with Plaid's body on response.data. */
const plaidFailure = (path: string, code: string) =>
  Object.assign(new Error("Request failed with status code 500"), {
    config: { url: `https://production.plaid.com${path}` },
    response: { data: { error_type: "API_ERROR", error_code: code, error_message: "unexpected" } },
  });

function gateway(api: Record<string, () => Promise<unknown>>) {
  const g = new PlaidApiGateway({
    PLAID_CLIENT_ID: "client",
    PLAID_SECRET: "secret",
    PLAID_ENV: "sandbox",
    TIDYSUM_TOKEN_KEY: Buffer.alloc(32).toString("base64"),
  });
  Object.assign((g as unknown as { api: object }).api, api);
  return g;
}

describe("PlaidApiGateway.getAccounts", () => {
  it("falls back to the balances Plaid already has when the live check fails at the bank", async () => {
    const g = gateway({
      accountsBalanceGet: () =>
        Promise.reject(plaidFailure("/accounts/balance/get", "INTERNAL_SERVER_ERROR")),
      accountsGet: () => Promise.resolve({ data: { accounts: [account(1234.5)] } }),
    });
    const accounts = await g.getAccounts("access");
    expect(accounts.map((a) => a.balances.current)).toEqual(["1234.5"]);
  });

  it("names the endpoint that failed, and doesn't hide a login problem", async () => {
    const g = gateway({
      accountsBalanceGet: () =>
        Promise.reject(plaidFailure("/accounts/balance/get", "ITEM_LOGIN_REQUIRED")),
      accountsGet: () => Promise.reject(new Error("must not be called")),
    });
    const err = await g.getAccounts("access").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlaidApiError);
    expect((err as PlaidApiError).errorCode).toBe("ITEM_LOGIN_REQUIRED");
    expect((err as PlaidApiError).message).toBe(
      "API_ERROR/ITEM_LOGIN_REQUIRED from /accounts/balance/get: unexpected",
    );
  });
});
