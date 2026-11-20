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

## The easy way: let your agent do it

Any agent that can run commands and use a browser works, with any model. In
[Claude Code](https://claude.com/claude-code), add [Claude in Chrome](https://claude.com/chrome) for
the browser steps. Open your agent in the folder where you keep projects and paste:

```text
Set up Tidysum for me: clone https://github.com/lucidity-finance/tidysum, follow
docs/connect-your-accounts.md, and connect my accounts. Stop and hand over to me
whenever a step needs my password, a code, my identity or my agreement to terms.
```

Your agent will:

1. Clone Tidysum, install it, start its database and write your `.env` file.
2. Open Plaid's sign-up page in your browser and fill in what it can.
3. Hand the page to you for the parts that are yours (see below), then carry on.
4. Copy your Plaid keys from the dashboard into `.env`.
5. Start Tidysum, open its **Connections** page and wait while you sign in to each bank.
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

You need Node 22.19 or newer, [pnpm](https://pnpm.io) and Docker.

```sh
git clone https://github.com/lucidity-finance/tidysum.git && cd tidysum
pnpm install
docker compose up -d                  # Postgres on 127.0.0.1:5432
cp .env.example .env
```

In `.env`, set `TIDYSUM_TOKEN_KEY` to the output of `openssl rand -base64 32`. This key encrypts
your Plaid tokens. Keep a copy somewhere safe: if you lose it, you have to connect every account
again.

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

In the Plaid dashboard, open **Developers → Keys**. Copy:

- **client_id** into `PLAID_CLIENT_ID`
- the **Production** secret into `PLAID_SECRET`

Then set `PLAID_ENV=production`. Your `.env` now has these lines filled in:

```sh
PLAID_CLIENT_ID=...
PLAID_SECRET=...
PLAID_ENV=production
TIDYSUM_TOKEN_KEY=...
```

Never commit `.env` or paste the secret anywhere else. Git already ignores the file.

### 4. Start Tidysum

```sh
pnpm tidysum migrate
pnpm tidysum user country CA          # only if you don't live in the US: CA, GB, DE, FR, ...
pnpm tidysum serve                    # open http://127.0.0.1:8080
```

Your country sets the currency Tidysum counts in, which banks Plaid offers, and which advice
applies (see [Outside the US](#outside-the-us)).

On a Mac, `bash deploy/macos-setup.sh` does this in the background instead, and keeps Tidysum
running after restarts ([guide](guide.md#running-on-your-mac)).

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
  page, and run `pnpm tidysum link-sandbox` for a test bank with two years of made-up history. Sandbox
  connections don't count toward your 10.
- **An institution Plaid can't reach?** Export a CSV from its website and run
  `pnpm tidysum import-csv` ([guide](guide.md#institutions-plaid-cant-reach)).
- **What Plaid sees.** Plaid connects to your banks on your behalf and passes the data to Tidysum on
  your computer. Tidysum sends nothing anywhere else. Plaid's own
  [end user privacy policy](https://plaid.com/legal/#end-user-privacy-policy) covers what Plaid does
  with it.
- **Outside the U.S. and Canada,** Plaid's free plan isn't available. See below.

## Outside the US

- **Canada** works with the free Plaid account. Run `pnpm tidysum user country CA` first: amounts
  are then in Canadian dollars, Plaid offers Canadian (and US) banks, money styles buy
  Canadian-listed funds, and cash is measured against the Bank of Canada's 3-month bill yield.
  The 401(k) and IRA checks are US tax law, so they stay off; TFSA and RRSP checks, and Canadian
  savings accounts and cards to compare with, aren't in yet.
- **UK and EU:** Plaid's free plan doesn't reach banks there, so for now import CSV exports
  (`pnpm tidysum import-csv --currency GBP ...`) after setting your country
  (`pnpm tidysum user country GB`). A free connector for UK and EU banks (Enable Banking) is next.
  If your Plaid team already has Plaid's European production access, set `PLAID_EUROPE=true`.
- **Accounts in another currency** (a US dollar account in Canada, say) are synced and listed, but
  left out of totals and findings rather than added up as if they were the same money.

## Notes for agents

If you are an agent following this page for someone:

- Write `PLAID_SECRET` and `TIDYSUM_TOKEN_KEY` straight into `.env`. Never print them, repeat them
  in chat or put them in a command line that gets logged.
- Hand the browser to the person for their Plaid password and codes, Plaid's identity check,
  accepting Plaid's terms, and every bank sign-in inside Plaid Link. Don't type those for them.
- Never remove a connection to fix it: that spends one of the 10 free connections. Use
  **Reconnect**.
- If the person doesn't live in the US, run `pnpm tidysum user country <code>` right after
  `migrate`, before linking.
- After the first sync, run `pnpm tidysum agent setup --dry-run`, show the person what it would
  change, and ask them to run `pnpm tidysum agent setup` in their own terminal.
