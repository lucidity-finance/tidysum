import { PlaidApiError, type PlaidGateway } from "./gateway.js";

/**
 * Stands in for Plaid when only Enable Banking is set up (someone in the UK or EU): any Plaid call
 * fails with a reason instead of reaching Plaid with no keys.
 */
export function unconfiguredPlaid(): PlaidGateway {
  return new Proxy({} as PlaidGateway, {
    get: (_target, name) => {
      if (name === "then") return undefined;
      return async () => {
        throw new PlaidApiError(
          "TIDYSUM",
          "PLAID_NOT_CONFIGURED",
          `Plaid isn't set up (PLAID_CLIENT_ID and PLAID_SECRET), so ${String(name)} can't run`,
        );
      };
    },
  });
}
