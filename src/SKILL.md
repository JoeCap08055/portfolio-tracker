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

### 0a — Parse the Sheet Reference & Fetch the Ledger

⚠️ **CRITICAL — The Google Sheets API is NOT available. Do NOT attempt any Sheets API calls,
do NOT use `http_request` to call any `sheets.googleapis.com` endpoint, and do NOT attempt
OAuth-based Sheets access under any circumstances. The only permitted method to read the
spreadsheet is `web_browser` as described below.**

Resolve the **Spreadsheet ID** from the required input:

- URL pattern: `https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/edit...`
- Raw ID input: `{SPREADSHEET_ID}`

The CSV export URL pattern for each tab is:

```
https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/export?format=csv&gid={GID}
```

Common GIDs:

- Holdings tab: `gid=0` (default first sheet)
- Transactions tab: check the sheet's tab order; use `gid=` from the tab's URL
- Performance Log tab: check the sheet's tab order

**Fetch strategy — use `web_browser` exclusively:**

Use `web_browser` to navigate to the CSV export URL for each tab, then use `extractText`
to capture the content. The browser handles Google's multi-hop redirect and session flow
natively.

Example steps:

```
navigate → https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/export?format=csv&gid=0
extractText → body
```

**On failure:**
If `web_browser` returns an empty body or an error page, report the exact content received
and halt with a clear message asking the user to verify the sheet is shared as
"Anyone with the link — Viewer". Do NOT proceed with the simulation based on stale or
missing data.

**Do NOT:**

- Attempt to use the Sheets API or any `sheets.googleapis.com` endpoint — it is not available
- Conclude "auth problem" or "API required" based on redirect or timeout errors alone
- Use hardcoded or previously cached spreadsheet data — always fetch fresh on each run

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

Do NOT use a stale or market close price as a basis for a trade. If a live price is not available
for a security, do not attempt to trade that security.

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
don't feed this run's buys, the ordering makes the ledger easier to audit.

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

### Approach A — Via CSV Email + Apps Script (primary)

Generate CSVs and email them. The user's Apps Script auto-imports within 5 minutes.

### Approach B — Provide Artifact Downloads

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

⚠️ **The Google Sheets API is NOT available.** Do not attempt any Sheets API calls.

- Include the Performance Log row clearly in the simulation report HTML under a
  "Performance Log Entry" section, formatted as a copyable table row.
- Include it in the email body under the summary section so the user can paste it manually
  if needed.

---

## Step 5 — Email the CSVs (ALWAYS DO THIS — PARSER CONTRACT)

**Resolve the recipient email at runtime.** Use the email address associated with the
user's connected Google account. Do NOT use any hardcoded email address.

Use `google_gmail_send` to send the email.

---

### ⚠️ EMAIL FORMAT SPECIFICATION — THIS IS A MACHINE PARSER CONTRACT, NOT A TEMPLATE

The email subject and body are consumed by an Apps Script that uses exact string matching
to locate section markers, parse CSV blocks, and route data into the correct spreadsheet
tabs. **Any deviation — a wrong character, an extra space, a different dash, HTML tags,
emoji, a reworded marker — causes the Apps Script to silently fail and discard the email.**

Treat every character in the subject line and every marker in the body as a machine
instruction. Do not paraphrase, summarize, reformat, add helpfulness, or deviate in any way.

---

### Subject Line — Exact Format

```
Portfolio Simulation Results — YYYY-MM-DD HH:MM ET
```

**The separator between "Results" and the date is an em dash (—), NOT a hyphen (-) or en dash (–).**

| ✅ Valid   | `Portfolio Simulation Results — 2026-04-15 14:30 ET`                       |
|-----------|----------------------------------------------------------------------------|
| ❌ Invalid | `Portfolio Simulation Results - 2026-04-15 14:30 ET` ← hyphen              |
| ❌ Invalid | `Portfolio Simulation Results – 2026-04-15 14:30 ET` ← en dash             |
| ❌ Invalid | `Portfolio Simulation Results — 04/15/2026 2:30 PM ET` ← wrong date format |
| ❌ Invalid | `Re: Portfolio Simulation Results — 2026-04-15 14:30 ET` ← prefix          |
| ❌ Invalid | `📊 Portfolio Simulation Results — 2026-04-15 14:30 ET` ← emoji prefix     |

Use 24-hour time (HH:MM). Use the verified ET time from Step 0b.

**Do NOT include any HTML in the subject line.** Plain text only.

---

### Body Format — Exact Structure

**Do NOT include any HTML in the email body.** The body must be plain text only.
HTML tags, bold markers, bullet symbols, or any markup will break the Apps Script parser.

The body must follow this exact structure, in this exact order, with these exact markers:

```
SUMMARY
[Free-text summary of the simulation run. Include: starting portfolio value, ending
portfolio value, net gain/loss ($), net gain/loss (%), number of trades simulated,
total simulated fees, market status (OPEN/CLOSED), opening cash balance, and a brief
plain-English rationale for the trades taken. Also include the Performance Log row here
as a plain-text line for manual reference.]

HOLDINGS_CSV_START
Asset,Class,Quantity,Avg Cost,Current Price,Market Value,Allocation %,Notes
[one row per holding — no blank lines between rows]
HOLDINGS_CSV_END

TRANSACTIONS_CSV_START
Date,Time ET,Action,Asset,Class,Quantity,Price,Value,Fee,Net Value,Rationale
[one row per trade — SELLs first, then BUYs — no blank lines between rows]
[If no trades were simulated, include the header row only — do NOT omit this block]
TRANSACTIONS_CSV_END
```

**Marker rules — each marker must appear on its own line, exactly as written:**

| Marker                         | Rule                                                                      |
|--------------------------------|---------------------------------------------------------------------------|
| `SUMMARY`                      | Standalone line. No colon, no prefix, no suffix.                          |
| `=== HOLDINGS CSV ===`         | Standalone line immediately before the header row.                        |
| `=== END HOLDINGS CSV ===`     | Standalone line immediately after the last data row.                      |
| `=== TRANSACTIONS CSV ===`     | Standalone line immediately before the header row.                        |
| `=== END TRANSACTIONS CSV ===` | Standalone line immediately after the last data row (or header-only row). |

**Do NOT:**

- Add blank lines between a marker and its header row, or between its last data row and the closing marker
- Add any text, labels, or commentary inside the CSV blocks
- Wrap CSV content in code fences (``` or ~~~)
- Use any markdown formatting anywhere in the body
- Add a preamble, greeting, or sign-off before `SUMMARY` or after `=== END TRANSACTIONS CSV ===`

---

### CSV Format Requirements

**Holdings CSV columns (exact header, exact order):**
`Asset,Class,Quantity,Avg Cost,Current Price,Market Value,Allocation %,Notes`

**Transactions CSV columns (exact header, exact order):**
`Timestamp,Action,Asset,Class,Quantity,Price,Value,Fee,Net Value,Rationale`

**Formatting rules:**

- Dollar amounts: 2 decimal places, no `$` sign (e.g. `5148.22`, not `$5,148.22`)
- Percentages: 2 decimal places, no `%` sign (e.g. `12.50`, not `12.5%`)
- Crypto quantities: 4 decimal places (e.g. `0.0312`)
- Equity/ETF quantities: 2 decimal places (e.g. `10.00`)
- Dates: `YYYY-MM-DD`
- Times: `HH:MM` in 24-hour ET
- Timestamps: `YYYY-MM-DDTHH:MM +/-HHMM` in ISO data + 24-hour ET
- No BOM, no trailing commas, no extra whitespace, no thousands separators
- No blank lines within a CSV block

**Sign convention (CRITICAL — must match exactly):**

- BUY `Net Value`: negative number (e.g. `-523.45`) — cash outflow
- SELL `Net Value`: positive number (e.g. `1204.80`) — cash inflow

---

### Pre-Send Checklist (MANDATORY — verify every item before calling `google_gmail_send`)

Before sending the email, confirm ALL of the following:

- [ ] Subject uses em dash (—), not hyphen or en dash
- [ ] Date in subject is `YYYY-MM-DD` format
- [ ] Time in subject is 24-hour `HH:MM ET` format
- [ ] Subject has no HTML, emoji, or prefix
- [ ] Body is plain text — zero HTML tags anywhere
- [ ] `SUMMARY` marker is on its own line with no trailing characters
- [ ] `HOLDINGS_CSV_START` and `HOLDINGS_CSV_END` are present, each on their own line
- [ ] `TRANSACTIONS_CSV_START` and `TRANSACTIONS_CSV_END` are present, each on their own line
- [ ] No blank lines between markers and their adjacent CSV rows
- [ ] Holdings CSV uses exact column header:
  `Asset,Class,Quantity,Avg Cost,Current Price,Market Value,Allocation %,Notes`
- [ ] Transactions CSV uses exact column header:
  `Date,Time ET,Action,Asset,Class,Quantity,Price,Value,Fee,Net Value,Rationale`
- [ ] BUY Net Values are negative; SELL Net Values are positive
- [ ] Total BUY outflow does not exceed Run Opening Cash Balance
- [ ] No markdown, code fences, or extra commentary inside CSV blocks
- [ ] No preamble before `SUMMARY`, no sign-off after `TRANSACTIONS_CSV_END`

If any item fails this checklist, fix it before sending. Do not send a non-conforming email.

**On email send failure:**
If `google_gmail_send` returns an error, attach the Holdings and Transactions CSVs as
downloadable artifacts in the chat response so the user can manually import them.
Never silently swallow an email failure.

---

## Step 6 — Simulation Report

After the email is sent (or after the artifact fallback), produce a clean HTML simulation
report in the chat. The report should include:

- Run timestamp and market status
- Portfolio summary table (before and after)
- Trade log with rationale
- Allocation breakdown (before and after, by class)
- News signals that drove decisions
- Performance Log entry (copyable)
- Any warnings or edge cases encountered during the run

The HTML report is for human readability — it is separate from the plain-text email and
is not parsed by any script. It may use formatting, tables, and color.
