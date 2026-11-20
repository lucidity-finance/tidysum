# Connect your accounts

Tidysum reads your banks, cards, brokerages and retirement plans through
[Plaid](https://plaid.com), the service most finance apps use to connect to banks. Anyone can make a
free Plaid account, and the free plan is enough to connect a whole household's money. This page
walks through the setup from start to finish. Your AI agent can do almost all of it for you.

**What you get for free:** Plaid's Trial plan gives you real bank data at no cost, with no business
or company needed. It covers up to **10 connections**. A connection is one sign-in at one
institution, so your bank, two card issuers, a brokerage and a 401(k) use five. It includes
everything Tidysum reads: transactions, balances, investments and card and loan details. Nearly
every large U.S. institution works on it, including Chase, Bank of America, Wells Fargo, Capital
One, Citi, American Express and U.S. Bank.

**How long it takes:** about 15 minutes, most of it Plaid's sign-up form.

**No Plaid account?** [SimpleFIN Bridge](#without-plaid-simplefin-bridge) is the other way in: about
$15 a year, no keys or sign-up form on Tidysum's side, and you can mix the two.

## The easy way: let your agent do it

Any agent that can run commands and use a browser works, with any model. In
[Claude Code](https://claude.com/claude-code), add [Claude in Chrome](https://claude.com/chrome) for
the browser steps. Paste:

```text
Set up Tidysum for me: follow
https://github.com/lucidity-finance/tidysum/blob/main/docs/connect-your-accounts.md
and connect my accounts. Stop and hand over to me whenever a step needs my password,
a code, my identity or my agreement to terms.
```

Your agent will:

1. Install Tidysum with its one-line installer, if it isn't installed yet.
2. Open Plaid's sign-up page in your browser and fill in what it can.
3. Hand the page to you for the parts that are yours (see below), then carry on.
4. Copy your Plaid keys from the dashboard into Tidysum's `.env` file.
5. Restart Tidysum, open its **Connections** page and wait while you sign in to each bank.
6. Run the first sync and tell you what Tidysum found.

What only you do, because it is your identity and your agreement:

- Choose your Plaid password and enter the codes Plaid sends you.
- Verify your identity with Plaid, if it asks.
- Accept Plaid's terms.
- Sign in to each of your banks inside Plaid's window, and enter their codes.

Your agent never needs your bank passwords. They go straight from you to your bank through Plaid,
and Tidysum only ever receives an access token, which it stores encrypted.

## Step by step, by hand

The same steps, if you'd rather do them yourself or want to see what your agent is doing.

### 1. Install Tidysum

On a Mac or Linux (on Windows, inside WSL), in a terminal:

```sh
curl -fsSL https://lucidity-finance.github.io/tidysum/install.sh | sh
```

That's all it needs: no Node, Docker or database to install first. Everything goes in
`~/.tidysum`, including Tidysum's own database and your settings file, `~/.tidysum/.env`, with a
fresh `TIDYSUM_TOKEN_KEY` already in it. That key encrypts your Plaid tokens. Keep a copy somewhere
safe: if you lose it, you have to connect every account again. When the installer finishes,
Tidysum is running at [http://127.0.0.1:8080](http://127.0.0.1:8080) and starts again at login.

Working on Tidysum's code instead? Clone it, `pnpm install`, and `cp .env.example .env`; with
`DATABASE_URL` left empty it runs its own database there too ([guide](guide.md#development)).

### 2. Make a free Plaid account

1. Go to [dashboard.plaid.com/signup](https://dashboard.plaid.com/signup).
2. Sign up with your email and confirm it.
3. When Plaid asks how you'll use it, choose **Personal use**. You don't need a company.
4. Fill in the short profile and verify your identity if Plaid asks. Most accounts are approved
   right away; if Plaid wants a closer look, it emails you within two or three business days.
5. Accept Plaid's terms. They ask you to keep your keys and the data you receive secure, which is
   what Tidysum's encrypted token store and local-only database are for.

New U.S. and Canadian accounts start on the **Trial plan**, which includes real ("Production")
access. There is nothing to apply for.

### 3. Put your keys in `.env`

Open `~/.tidysum/.env` (in a checkout, `.env` in the repository). In the Plaid dashboard, open
**Developers → Keys**. Copy:

- **client_id** into `PLAID_CLIENT_ID`
- the **Production** secret into `PLAID_SECRET`

Then set `PLAID_ENV=production`. Your `.env` now has these lines filled in:

```sh
PLAID_CLIENT_ID=...
PLAID_SECRET=...
PLAID_ENV=production
TIDYSUM_TOKEN_KEY=...
```

Never paste the secret anywhere else.

### 4. Restart Tidysum

```sh
tidysum user country CA               # only if you don't live in the US: CA, GB, DE, FR, ...
tidysum restart                       # picks up the keys; open http://127.0.0.1:8080
```

Your country sets the currency Tidysum counts in, which banks Plaid offers, and which advice
applies (see [Outside the US](#outside-the-us)).

In a checkout, run the same commands as `pnpm tidysum ...`, with `pnpm tidysum migrate` and
`pnpm tidysum serve` in place of `restart`. On a Mac, `bash deploy/macos-setup.sh` runs a checkout
in the background instead ([guide](guide.md#running-on-your-mac-from-a-checkout)).

### 5. Connect your accounts

1. Open [http://127.0.0.1:8080/#connections](http://127.0.0.1:8080/#connections) and click
   **Link institutions**.
2. Plaid's window opens. Add your phone number when it asks; Plaid uses it to remember you, so you
   enter one code per session, not one per bank.
3. Search for your bank, sign in, and pick the accounts to share. Plaid then offers to add another
   institution: keep going until they're all in. You can add them all in one session.
4. Close the window when you're done. Tidysum syncs right away, with up to two years of history, and
   then every six hours.

To see what it found, open the **Actions** page, or ask your agent _"What is my money costing
me?"_. To connect your agent to Tidysum, see [Connect your agent](../README.md#connect-your-agent).

## Good to know

- **Use your 10 connections carefully.** Each new sign-in uses one, and removing a connection does
  not give it back. When a bank asks you to sign in again, Tidysum shows a **Reconnect** button on
  that connection: it repairs the existing connection without using a new one. Don't remove it and
  link it again.
- **More than 10?** Upgrade from the Trial plan to a paid plan in the Plaid dashboard (**Get full
  access**). Plaid then bills per connection per month. Upgrading can't be undone.
- **Want to try it first?** Leave `PLAID_ENV=sandbox`, use the Sandbox secret from the same Keys
  page, and run `tidysum link-sandbox` for a test bank with two years of made-up history. Sandbox
  connections don't count toward your 10.
- **An institution Plaid can't reach?** Try [SimpleFIN Bridge](#without-plaid-simplefin-bridge),
  or export a CSV from its website and run `tidysum import-csv`
  ([guide](guide.md#institutions-plaid-cant-reach)).
- **What Plaid sees.** Plaid connects to your banks on your behalf and passes the data to Tidysum on
  your computer. Tidysum sends nothing anywhere else. Plaid's own
  [end user privacy policy](https://plaid.com/legal/#end-user-privacy-policy) covers what Plaid does
  with it.
- **Outside the U.S. and Canada,** Plaid's free plan isn't available. See below.

## Without Plaid: SimpleFIN Bridge

[SimpleFIN Bridge](https://bridge.simplefin.org) is a small paid service (about $15 a year, or
$1.50 a month, paid to SimpleFIN) that connects up to 25 US banks, cards and brokerages and shares
them, read-only, with apps you give a token to. Tidysum needs nothing set up for it: no keys, no
`.env` lines, no developer account. Use it if you'd rather not make a Plaid account, if Plaid won't
give you access, or for an institution Plaid can't reach. Plaid and SimpleFIN connections can sit
side by side.

1. Make an account at [bridge.simplefin.org](https://bridge.simplefin.org) and connect your banks
   there. You sign in to each bank on SimpleFIN's side; Tidysum never sees those passwords.
2. On Tidysum's **Connections** page, click **Link institutions**, then **SimpleFIN Bridge**. Follow
   **Open SimpleFIN Bridge** to create a setup token for Tidysum, copy it, and paste it in.
3. Tidysum trades the token for its own read-only access (a token works once), adds one connection
   per bank, and syncs up to a year of history, then every six hours. SimpleFIN refreshes from your
   banks about once a day.

Later:

- **Added a bank at SimpleFIN Bridge?** Open the SimpleFIN dialog again and click **Check for new
  banks**. No new token needed.
- **A bank asks you to sign in again** at SimpleFIN Bridge: its connection here shows **Fix at
  SimpleFIN**. If you turn Tidysum's access off at the Bridge, paste a new setup token to reconnect;
  your connections and history stay.
- **Removing a connection** here deletes its data in Tidysum. To stop SimpleFIN sharing it too,
  remove it at SimpleFIN Bridge.
- From a terminal, `tidysum simplefin -` reads a setup token from stdin, links and syncs; plain
  `tidysum simplefin` checks for new banks.

What's different from Plaid: SimpleFIN sends balances, posted transactions and, for most
brokerages, holdings (ticker, shares, value, cost basis). It sends no account types and no spending
categories, so Tidysum tells checking, savings, cards and brokerages apart from their names and
holdings, and categories from the merchant code card networks assign (groceries, dining, gas,
travel and so on) or plain descriptions like "Interest paid". It doesn't send card APRs or
statement details, so card interest is read from the charges themselves. Tidysum asks SimpleFIN at
most 20 times a day, under the Bridge's limit, so syncing never gets your access turned off.

## Outside the US

- **Canada** works with the free Plaid account. Run `tidysum user country CA` first: amounts
  are then in Canadian dollars, Plaid offers Canadian (and US) banks, money styles buy
  Canadian-listed funds, and cash is measured against the Bank of Canada's 3-month bill yield.
  The 401(k) and IRA checks are US tax law, so they stay off; TFSA and RRSP checks, and Canadian
  savings accounts and cards to compare with, aren't in yet.
- **UK and EU:** Plaid's free plan doesn't reach banks there. Tidysum connects them through
  [Enable Banking](https://enablebanking.com) instead, whose free mode covers your own accounts
  at 2,500+ banks in 29 European countries. You need no Plaid account. See
  [UK and EU banks](#uk-and-eu-banks) below. Brokerages, ISAs and pensions aren't covered by open
  banking: import them as CSV or enter holdings by hand.
- **Plaid with European access:** if your Plaid team already has Plaid's European production
  access, set `PLAID_EUROPE=true` and Plaid offers banks where you live.
- **Accounts in another currency** (a US dollar account in Canada, say) are synced and listed, but
  left out of totals and findings rather than added up as if they were the same money.

## UK and EU banks

1. Set your country: `tidysum user country GB` (or `DE`, `FR`, `NL`, ...).
2. Sign up at [enablebanking.com](https://enablebanking.com/sign-in/) (a one-time link by email)
   and open **Applications** in the Control Panel. Add an application:
   - **Environment:** Production.
   - **Name:** anything, such as "Tidysum (personal)". Your bank shows it when you sign in.
   - **Redirect URL:** `https://lucidity-finance.github.io/tidysum/bank-callback.html`. Banks only
     send you back to an https address; that page runs in your browser and passes you on to
     Tidysum on `127.0.0.1`, and only there. If your Tidysum has its own https address, register
     `https://<that address>/enable-banking/callback` instead.
   - **Privacy and terms URLs, email:** your own; in the free mode they are only shown to you.
   - **Key:** keep "generate in the browser". Enable Banking downloads `<application id>.pem`.
3. Click **Activate by linking accounts** and sign in to each bank whose accounts you want. The
   free mode only ever returns accounts linked here.
4. Put the key file somewhere safe (outside the repository) and fill in `.env`:

   ```sh
   ENABLE_BANKING_APP_ID=<the application id>
   ENABLE_BANKING_KEY_FILE=/path/to/<application id>.pem
   ENABLE_BANKING_REDIRECT_URL=https://lucidity-finance.github.io/tidysum/bank-callback.html
   ```

   Leave the Plaid lines empty. `TIDYSUM_TOKEN_KEY` is still needed.
5. Start Tidysum and, on **Connections**, click **Link institutions**, pick your bank and sign in.
   Tidysum syncs up to two years of booked transactions (what your bank gives) and then every six
   hours; banks allow about four background reads a day.
6. Banks ask you to renew access, usually every 90 or 180 days. When one does, its connection shows
   **Reconnect**.

Open banking has no spending categories, holdings or card APRs, so card and investment checks have
less to work with than in the US.

## Notes for agents

If you are an agent following this page for someone:

- Install with the one-line installer above unless the person already has Tidysum (`tidysum
  status` answers) or wants a checkout. Its `.env` is `~/.tidysum/.env`, and after changing it run
  `tidysum restart`.
- Write `PLAID_SECRET` and `TIDYSUM_TOKEN_KEY` straight into `.env`. Never print them, repeat them
  in chat or put them in a command line that gets logged.
- Hand the browser to the person for their Plaid password and codes, Plaid's identity check,
  accepting Plaid's terms, and every bank sign-in inside Plaid Link. Don't type those for them.
- Never remove a connection to fix it: that spends one of the 10 free connections. Use
  **Reconnect**.
- If the person doesn't live in the US, run `tidysum user country <code>` before linking.
- With SimpleFIN Bridge instead of Plaid, the person makes the account, connects their banks and
  creates the setup token themselves. Have them paste it on the Connections page, or pipe it to
  `tidysum simplefin -`. A setup token works once and gives read access: never print it or put it
  in a command line that gets logged.
- After the first sync, run `tidysum agent setup --dry-run`, show the person what it would
  change, and ask them to run `tidysum agent setup` in their own terminal. (In a checkout, these
  commands are `pnpm tidysum ...`.)
