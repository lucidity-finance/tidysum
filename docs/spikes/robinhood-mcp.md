# Spike: Robinhood Agentic Trading MCP

Goal (Phase 0): learn how a self-built client authenticates to
`https://agent.robinhood.com/mcp/trading`, and capture its tool list and schemas in this
repo before designing the execution adapter.

## Status

Not done yet. It needs the owner's Robinhood login on a desktop, so it can't run from CI or a
cloud container (the cloud sandbox can't reach the endpoint at all).

## Steps

1. On desktop, create the Robinhood agentic account and enable agent access.
2. Point the MCP Inspector at the endpoint. It runs the OAuth flow if the server
   advertises one:

   ```sh
   npx @modelcontextprotocol/inspector
   # Transport: Streamable HTTP, URL: https://agent.robinhood.com/mcp/trading
   ```

3. Record here:
   - the auth mechanism (OAuth 2.1 with dynamic client registration, a static token, or
     something else) and whether it works for a non-Claude, non-Codex client;
   - token lifetime and refresh behaviour;
   - which tools need approval previews on Robinhood's side.
4. Save `tools/list` output to `docs/spikes/robinhood-tools.json`.

## Questions this must answer before Phase 4

- Does every order tool accept a client order id (an idempotency key)? If not, how do we
  look an order up after a timeout?
- Is there a read tool for order status and positions in the agentic account?
- Are limit orders and cancels exposed? The Phase 4 smoke test is a far-below-market limit
  buy and then a cancel.
