# Portfolio Simulator Skill

## Run/Input Contract

This skill accepts exactly one required input:

- A Google Sheets reference, provided as either:
  - Full URL: `https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/edit...`
  - Raw ID: `{SPREADSHEET_ID}`

Invocation requirement:

- Run this skill with one argument only: the sheet URL or spreadsheet ID.

Normalization and validation:

- If input is a URL, extract `{SPREADSHEET_ID}` from `/spreadsheets/d/{SPREADSHEET_ID}/`.
- If input is already a raw ID, use it as-is.
- If neither form yields a non-empty spreadsheet ID, fail fast with a clear error that includes the expected formats.

---

## Purpose

This skill connects to a portfolio ledger (Google Sheets), reads current holdings across asset
classes (cash, equities, fixed income, crypto), gathers **live intraday market data**, uses
**financial news** to identify high-conviction trade candidates, simulates intelligent trades
respecting market hours and fee economics, and emails the user Holdings + Transactions CSVs
for automatic import via Apps Script.

No real money is ever moved. This is a simulation engine, not a brokerage.

---

## Step -1 — Self-Refresh (ALWAYS RUN FIRST, BEFORE ANYTHING ELSE)

**At the very start of every run, before reading the ledger, before checking market hours,
before doing anything else — fetch the latest version of this SKILL.md from GitHub and use
it as the authoritative instructions for the remainder of this run.**

**Fetch URL:**

```
GET https://raw.githubusercontent.com/JoeCap08055/portfolio-tracker/main/src/SKILL.md
```

Use `http_request` with method GET and the URL above.

**On success (HTTP 200):**

- Replace the currently loaded skill instructions with the fetched content.
- Proceed silently to Step 0 — do NOT announce that a refresh occurred unless something
  materially changed (e.g. a new step was added or a rule was modified).
- Do NOT re-execute Step -1 when reading the fetched version — this step is skipped
  on the refreshed copy to prevent infinite recursion.

**On failure (network error, timeout, non-200 response):**

- Log a brief warning in the final simulation report: "⚠️ Could not fetch latest SKILL.md
  from GitHub (reason: [error]). Running with cached version."
- Continue with the currently loaded instructions — never abort the run due to a
  failed self-refresh.

---

## Step 0 — Extract Inputs & Check Market Hours

### 0a — Parse the Sheet Reference

Resolve the **Spreadsheet ID** from the required input:

- URL pattern: `https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/edit...`
- Raw ID input: `{SPREADSHEET_ID}`

**IMPORTANT — Always use `web_browser` to fetch the sheet CSV.** Do NOT use `http_request`
for this step. The Google Sheets CSV export endpoint returns a short-lived signed redirect
that expires before `http_request` can follow it. The `web_browser` tool handles the redirect
and session flow natively and reliably.

Fetch as CSV using `web_browser` to navigate to:

```
https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/export?format=csv&gid=0
```

Then use `extractText` to capture the CSV content from the page.

### 0b — Determine Market Status (CRITICAL — Check This First)

**IMPORTANT — Always retrieve the current time from a live source. Do NOT rely on your
training data, system clock assumptions, or any hardcoded time.** This skill runs inside
an AWS us-east-2 (US Eastern) container, but container clocks can drift and timezone
configuration may vary. Always verify with an external time source.

**Step 1 — Fetch live current time:**
Use `http_request` to fetch the current UTC time from a reliable public time API:

```
GET https://worldtimeapi.org/api/timezone/America/New_York
```

This returns the current time already converted to US Eastern Time (ET), including
DST awareness. Parse the `datetime` field from the response.

Fallback if worldtimeapi.org is unavailable:

```
GET https://timeapi.io/api/Time/current/zone?timeZone=America%2FNew_York
```

Second fallback if timeapi.io is unavailable:

```
GET https://worldclockapi.com/api/json/est/now
```

If all three fail, use `web_search` with query `"current time EST"` or `"current time ET"` and
parse the result. Only fall back to the system-provided context time as a last resort,
and clearly note in the report that the time source was unverified.

**Step 2 — Determine market open/closed** using the verified ET time. NYSE and NASDAQ are open:

- **Days:** Monday–Friday only
- **Hours:** 9:30 AM – 4:00 PM ET
- **Closed on:** US federal market holidays (New Year's Day, MLK Day, Presidents' Day,
  Good Friday, Memorial Day, Juneteenth, Independence Day, Labor Day, Thanksgiving,
  Christmas Day). When a holiday falls on a weekend, the market closes the nearest weekday.

**Apply these rules strictly:**

| Asset Class                         | Market Open         | Market Closed                       |
|-------------------------------------|---------------------|-------------------------------------|
| **Equity** (NYSE/NASDAQ)            | ✅ Simulate trades   | ❌ Skip — do NOT simulate buys/sells |
| **Fixed Income ETFs** (NYSE/NASDAQ) | ✅ Simulate trades   | ❌ Skip — do NOT simulate buys/sells |
| **Crypto** (Coinbase, 24/7)         | ✅ Always simulate   | ✅ Always simulate                   |
| **Cash**                            | ✅ Rebalance anytime | ✅ Rebalance anytime                 |

When markets are closed, **still run the simulation for crypto** and produce a report — but
clearly note that equity/fixed income trades are paused until market open. Do not skip the
run entirely just because US markets are closed.

Pre-market (4:00–9:30 AM ET) and after-hours (4:00–8:00 PM ET) sessions exist but are
illiquid and high-spread — do not simulate trades in these windows unless the user
explicitly requests it.

---

## Step 1 — Read the Ledger

Fetch the sheet CSV using `web_browser` (see Step 0a) and parse holdings. Expected schema
(flexible naming):

| Column        | Description                                   |
|---------------|-----------------------------------------------|
| Asset         | Ticker or name (e.g. AAPL, BTC, TLT, Cash)    |
| Class         | `equity`, `fixed_income`, `crypto`, or `cash` |
| Quantity      | Number of shares/units/dollars held           |
| Avg Cost      | Average cost basis per unit                   |
| Current Price | Last known price per unit                     |
| Market Value  | Quantity × Current Price                      |
| Allocation %  | Percentage of total portfolio market value    |
| Notes         | Optional context                              |

Adapt gracefully if column names differ.

After parsing, identify the **available cash balance** — this is the total dollar value of
all rows where `Class = cash`. Record this as the **Run Opening Cash Balance**. This is the
only cash available for any buy trade in this entire run. Cash generated from sells during
this run is NOT added to this balance — it is deferred to the next run.

---

## Step 2 — Fetch Live Intraday Prices

**Do NOT use end-of-day or closing prices.** Always fetch the most current intraday quote.

### Price Fetching Order (IMPORTANT — Batch Efficiently)

**Fetch ALL crypto prices via Coinbase API FIRST** — these calls are instant, free, and
require no rate limiting. Only after all crypto prices are fetched should you move on to
equity prices via `web_search`.

**Crypto (Coinbase — always fetch first):**

1. **Coinbase API** (free, no auth required for spot prices):
   ```
   GET https://api.coinbase.com/v2/prices/{SYMBOL}-USD/spot
   ```
   Example: `https://api.coinbase.com/v2/prices/BTC-USD/spot`
   Response: `{"data": {"amount": "72345.67", "currency": "USD"}}`
2. **CoinGecko** — search: `"{SYMBOL}" price USD coinGecko` (fallback only)
3. **Yahoo Finance** — search: `"{SYMBOL}-USD" crypto price` (fallback only)

**Equities & Fixed Income ETFs (NYSE/NASDAQ — fetch after crypto):**

1. **Yahoo Finance intraday quote** — search: `site:finance.yahoo.com "{TICKER}" stock quote`
   or fetch: `https://finance.yahoo.com/quote/{TICKER}`
2. **Google Finance** — search: `"{TICKER}" stock price right now`
3. **MarketWatch** — search: `site:marketwatch.com "{TICKER}" stock price`

**Always note the timestamp of each price quote.** If a price is > 15 minutes old, flag it
as potentially stale. If intraday price cannot be determined, use last known price from
sheet and clearly label it as stale.

**Only fetch prices for:**

1. Assets currently held in the portfolio
2. News-researched candidates identified in Step 3a

Do NOT speculatively fetch prices for assets not in the portfolio and not news-identified.

Add a 1-second delay between `web_search` calls for equity prices to avoid rate limiting.
No delay is needed between Coinbase API calls.

---

## Step 3 — News-Driven Research & Trade Simulation

This skill runs frequently (hourly or more). The strategy should exploit **intraday
opportunities** surfaced by breaking news, while keeping fee costs front of mind.

### 3a — News Scan (Do This BEFORE Deciding Trades)

**Approved news sources only.** Do not consult any sources outside this list:

| Category           | Approved Sources                 | site: filter                                                      |
|--------------------|----------------------------------|-------------------------------------------------------------------|
| **Breaking news**  | CNN, Reuters                     | `site:cnn.com`, `site:reuters.com`                                |
| **Financial news** | Yahoo Finance, MarketWatch, CNBC | `site:finance.yahoo.com`, `site:marketwatch.com`, `site:cnbc.com` |

Search for current financial news to identify high-conviction signals using only approved
sources:

1. **Broad market pulse:**
   `"stock market today" OR "market movers today" site:finance.yahoo.com OR site:marketwatch.com OR site:cnbc.com OR site:reuters.com OR site:cnn.com`

2. **For each current holding** (equity + crypto only — skip fixed income for news):
   `"{TICKER}" news today site:finance.yahoo.com OR site:marketwatch.com OR site:cnbc.com OR site:reuters.com OR site:cnn.com`

3. **New candidate discovery:**
   `"top stock movers today" OR "breakout stocks today" site:finance.yahoo.com OR site:marketwatch.com OR site:cnbc.com`
   `"crypto gaining today" OR "bitcoin ethereum news" site:cnbc.com OR site:reuters.com`

From news results, build a **Research List** of:

- **Holdings with new signals** — existing positions where news changes the thesis
- **New candidates** — assets not yet held that have strong bullish news catalysts

Limit the Research List to a maximum of **5 new candidates** to keep price fetches lean.
Fetch live prices only for Research List items (in addition to current holdings). Refer to step 2 for fetching live
prices.

### 3b — Fee-Aware Trade Scoring

Since this skill runs hourly, trades must clear a **minimum expected payoff** to justify
the simulated fee cost. Apply this logic before including any trade:

**Assumed fee structure (simulated):**

- Equity trades: $0 commission (assumes Robinhood/Fidelity zero-commission)
- Crypto trades: 0.6% of trade value (Coinbase standard fee)
- Fixed income ETF trades: $0 commission

**Minimum payoff threshold:**

- Equity: Expected gain must be > 0.5% of trade value to justify the churn
- Crypto: Expected gain must be > 1.5% of trade value (to exceed 0.6% buy + 0.6% sell fee
  plus slippage). Do not chase small crypto moves.
- Fixed income: Only rebalance if allocation is off by > 5% from target — these are
  stability anchors, not trading vehicles.

**Intraday churn rule:** If the same asset was simulated as traded in the last run
(check Transactions tab for today's date), require a stronger signal (2× the minimum
threshold) before simulating another trade in that asset. This prevents thrashing.

### 3c — Allocation Analysis

Compute current allocation % by class. Compare to target:

- Cash: 5–10%
- Equity: 55–65%
- Fixed Income: 20–25%
- Crypto: 5–10%

### 3d — Cash Constraint Rule (CRITICAL — Enforce Before Every Buy)

**All simulated buy trades must be funded exclusively from the Run Opening Cash Balance.**
This is the cash balance recorded at the start of Step 1 — it does not change during the run.

**Sign convention (IMPORTANT):**

- **BUY transactions:** `Net Value` is **negative** (cash outflow — money leaves cash to buy asset)
- **SELL transactions:** `Net Value` is **positive** (cash inflow — money returns to cash)

**Cash cap enforcement — use this exact logic:**

Maintain a running `cash_spent` accumulator (starts at 0). Before adding each BUY:

```
required_cash = abs(net_value_of_buy)   # net_value is negative, so take absolute value
if cash_spent + required_cash > Run Opening Cash Balance:
    trim quantity to fit, or drop the trade entirely
else:
    cash_spent += required_cash
```

**Final sanity check (MANDATORY — before emitting ANY output):**

```
total_buy_outflow = sum(abs(Net Value) for all BUY rows)
assert total_buy_outflow <= Run Opening Cash Balance
```

If this check fails, remove or reduce BUY rows until it passes. Do NOT emit CSVs, email,
or report until this check passes.

**Two key rules that work together:**

1. **Buys are limited to the Run Opening Cash Balance.** The sum of `abs(Net Value)` for
   all BUY rows must never exceed the Run Opening Cash Balance.

2. **Cash from sells in this run is NOT available for buys in this run.** When you simulate
   a sell, the proceeds are deferred — they will be reflected in the ledger for the *next*
   run, not this one. Do not add sell proceeds to the available cash balance mid-run.

**If the Run Opening Cash Balance is insufficient to fund desired buys:**

- Determine which holdings to sell to raise cash for *future* runs (record those sells).
- Only buy what the opening cash balance can actually cover right now.
- Clearly note in the report: "Additional cash from sells will be available next run."

**Trade sequencing within a single run:**
Record all SELLs first in the Transactions CSV, then all BUYs — even though sell proceeds
don't fund this run's buys, the ordering makes the ledger easier to audit.

### 3e — Trade Logic (Markets Open for Equity/Fixed Income, Always for Crypto)

Generate simulated trades using this hierarchy, always respecting the cash constraint
in 3d above:

1. **News-driven buys** — if a Research List candidate has strong bullish news AND passes
   fee threshold AND adding it improves allocation balance AND cash is available → BUY
2. **News-driven sells** — if a held asset has bearish news (earnings miss, regulatory
   action, major negative catalyst) AND passes fee threshold → SELL
3. **Trim overweight, underperforming** — sell if overweight AND bearish 30-day momentum
4. **Add to underweight, outperforming** — buy if underweight AND bullish momentum AND
   cash is available
5. **Deploy excess cash** — if cash > 10%, invest into best-signal eligible asset
6. **Fixed income buffer** — if equity > 65%, trim and add to fixed income

For each trade record:

- Timestamp (Date AND Time) Action, Asset, Quantity, Price, Value, Fee (simulated), Net Value, Rationale (cite news or
  signal)
- **Do NOT include a Realized P&L field** — accurate P&L requires FIFO/LIFO lot tracking
  that is out of scope for this simulation. Omit it entirely from both CSV and report.

---

## Step 4 — Update the Spreadsheet

### Approach A — Via Google Sheets API (if OAuth available)

Use `http_request` to PATCH/PUT updated values via Sheets API.

### Approach B — Via CSV Email + Apps Script (primary fallback)

Generate CSVs and email them. The user's Apps Script auto-imports within 5 minutes.

### Approach C — Provide Artifact Downloads

Always produce downloadable CSVs as a backup regardless of write-back method.

---

## Step 4.5 — Log to Performance Log Tab

After each run, append a one-row summary to the **Performance Log** tab in the Google Sheet.
This builds a track record over time so the user can evaluate simulation accuracy and trends.

**Performance Log row format:**
`Date, Time ET, Starting Value, Ending Value, Net Gain ($), Net Gain (%), # Trades, Simulated Fees, Opening Cash, Cash from Sells (deferred), Market Status, Notes`

**Example row:**
`2026-04-10, 12:09 ET, $5,018.87, $5,148.22, +$129.35, +2.58%, 2, -$0.75, $250.00, $0.00, OPEN, Bought UNH + ETH on news signals`

### How to append the Performance Log row:

**If Google Sheets API (OAuth) is available:**
Use `http_request` to append the row via the Sheets API:

```
POST https://sheets.googleapis.com/v4/spreadsheets/{SPREADSHEET_ID}/values/Performance Log!A:M:append?valueInputOption=USER_ENTERED
```

**If Sheets API is not available (fallback):**

- Include the Performance Log row clearly in the simulation report HTML under a
  "Performance Log Entry" section, formatted as a copyable table row.
- Include it in the email body under the summary section so the user can paste it manually
  if needed.
- Note: "Auto-append to Performance Log tab requires Sheets API access. Row provided above
  for manual entry."

---

## Step 5 — Email the CSVs (ALWAYS DO THIS)

**Resolve the recipient email at runtime.** Use the email address associated with the
user's connected Google account. Do NOT use any hardcoded email address — always derive
the recipient from the authenticated Google integration so this skill works correctly for
any user who runs it.

Use `google_gmail_send` to send to the resolved recipient email with:

- **Subject:** `Portfolio Simulation Results - [YYYY-MM-DD HH:MM ET]`
  *(Include time since this runs intraday — multiple emails per day is expected)*
- **Body:** Full summary + inline CSV blocks (see template below)

### CSV Format Requirements

**Holdings CSV columns:**
`Asset, Class, Quantity, Avg Cost, Current Price, Current Value, Allocation %, Notes`

**Transactions CSV columns:**
`Timestamp, Action, Asset, Class, Quantity, Price, Value, Fee, Net Value, Rationale`

- **Do NOT include a Realized P&L column** in the Transactions CSV. It is intentionally
  omitted because accurate P&L requires FIFO/LIFO lot accounting that is out of scope.
  Do not add it back.

The `Timestamp` column must contain the **full date and time** of the simulated trade,
formatted in standard ISO datetime format: `YYYY-MM-DDTHH:MM:SS +/-offset`
Example: `2026-04-10T09:45:32 -0500`

Do NOT use a date-only value (e.g. `2026-04-10`) in the Timestamp column. Every
transaction row must carry the precise time it was simulated, not just the date.

**Net Value sign convention in CSV:**

- BUY rows: Net Value must be **negative** (e.g. `-124.96`)
- SELL rows: Net Value must be **positive** (e.g. `+843.20`)

### Email Body Template

⚠️ **CRITICAL — CSV BLOCK MARKERS MUST BE FOLLOWED EXACTLY, CHARACTER FOR CHARACTER.**
The markers below are parsed by an automated Apps Script. Any deviation — including
decorative Unicode characters (━, ═, etc.), extra spaces, different capitalization, or
changed punctuation — will break the import script. Copy them verbatim. No exceptions.

```
Hi [user's preferred name],

Your portfolio simulation for [DATE] at [TIME ET] is complete.

📊 SIMULATION SUMMARY
━━━━━━━━━━━━━━━━━━━━
Market Status:   [OPEN / CLOSED — equity/fixed income trades active/paused]
Starting Value:  $X,XXX.XX
Ending Value:    $X,XXX.XX
Simulated Gain:  +$XXX.XX (+X.X%)
Simulated Fees:  -$X.XX
Opening Cash:    $X,XXX.XX  ← cash available for buys this run
Cash from Sells: $X,XXX.XX  ← deferred; available next run

📰 KEY NEWS SIGNALS
━━━━━━━━━━━━━━━━━━━━
[2-3 bullet points of top news items that drove trade decisions, with source attribution]

📋 TRADES EXECUTED
━━━━━━━━━━━━━━━━━━━━
[List each trade: BUY/SELL | TICKER | QTY | PRICE | VALUE | FEE | REASON]
[If no equity trades: "Equity/fixed income trades paused — market closed"]
[If sells were made but buys were limited: note how much cash is deferred to next run]

🔄 NEXT RUN READINESS
━━━━━━━━━━━━━━━━━━━━
[If sells were executed this run, clearly state:]
  Sold [ASSET] for $X,XXX.XX → cash now available next run
  Intended buy: [ASSET] at ~$XXX.XX ([QTY] shares ≈ $X,XXX.XX)
  Action: This buy will be attempted automatically on the next simulation run.
[If no sells: "No deferred buys — all intended trades executed this run."]

📊 PERFORMANCE LOG ENTRY
━━━━━━━━━━━━━━━━━━━━
[DATE], [TIME ET], $[START], $[END], [NET$], [NET%], [#TRADES], $[FEES], $[OPEN_CASH], $[SELL_CASH], [MARKET_STATUS], [NOTES]

--- AUTOMATED IMPORT SECTION ---
⚠️ WARNING: The section below is parsed by an automated script.
Do NOT alter the marker lines in any way. They must appear EXACTLY as shown,
using only plain ASCII characters (=, space, letters). No Unicode, no decorations.

=== HOLDINGS CSV ===
Asset,Class,Quantity,Avg Cost,Current Price,Current Value,Allocation %,Notes
[one row per holding]
=== END HOLDINGS CSV ===

=== TRANSACTIONS CSV ===
Timestamp,Action,Asset,Class,Quantity,Price,Value,Fee,Net Value,Rationale
[one row per transaction, empty if no transactions]
=== TRANSACTIONS CSV ===
```

---

## Step 6 — Generate HTML Simulation Report

Generate a polished, self-contained HTML report as a downloadable artifact using `fs.write`
with `artifact: true`.

### Report Sections

1. **Header** — Title, run timestamp, market status badge (green OPEN / red CLOSED)
2. **Portfolio Snapshot** — Table of all holdings with live prices, current value,
   allocation %, and gain/loss vs avg cost
3. **Trade Log** — Table of all simulated trades this run (or "No trades — market closed"
   for equity/fixed income)
4. **Next Run Readiness** — If sells were executed, show what buys are queued for next run
5. **News Signals** — Bulleted list of key signals with source and sentiment label
6. **Allocation Chart** — Text-based bar chart showing current vs target allocation by class
7. **Performance Log Entry** — The exact row to be appended to the Performance Log tab,
   formatted as a copyable one-liner
8. **Methodology Notes** — Fee assumptions, data sources, simulation rules summary

---

## Edge Cases & Guardrails

- **No cash available:** If Run Opening Cash Balance = $0 and no sells are triggered,
  produce a report with no buy trades and note "Insufficient cash for buys this run."
- **All assets held, no new candidates:** Skip Step 3a candidate discovery, just update
  existing holdings.
- **Price fetch fails:** Use last known price from sheet, label as stale, do not trade
  that asset.
- **Sheet unreadable:** Abort and report the error clearly. Do not fabricate holdings.
- **Email send fails:** Produce artifact downloads and note the email failure in chat.
- **No news found:** Proceed with allocation-only rebalancing. Note "No news signals
  found — allocation-based trades only."
