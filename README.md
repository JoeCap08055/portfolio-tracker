# portfolio-tracker

Portfolio tracking and simulation automation centered around a Google Sheet ledger, a Codex skill, and a Google Apps Script importer.

## Repository Structure

- `src/SKILL.md`: Portfolio Simulator skill instructions (data flow, market-hour rules, pricing/news research, trade simulation logic, CSV/email output contract).
- `src/sheet_import.js`: Google Apps Script that ingests emailed CSV blocks into the `Holdings` and `Transactions` tabs in Google Sheets.
- `README.md`: Project overview and usage notes.

## Sheet Import Script Purpose

`src/sheet_import.js` is designed to close the loop after a simulation run:

- Watches Gmail for unread emails with subject `Portfolio Simulation Results`.
- Extracts `=== HOLDINGS CSV === ... === END HOLDINGS CSV ===` and `=== TRANSACTIONS CSV === ... === END TRANSACTIONS CSV ===` blocks from the email body.
- Replaces/updates the `Holdings` sheet, appends deduplicated `Transactions` rows, and reapplies formulas/formatting (including totals).
- Marks processed threads as read and labels them to prevent re-importing.
- Sends a confirmation email after processing.

In short: it turns simulation email output into spreadsheet updates automatically.

## Skill Overview and Invocation

The skill in `src/SKILL.md` is a high-level simulation workflow that:

- Reads holdings from a Google Sheet ledger.
- Fetches live market prices and approved-source news.
- Simulates fee-aware, cash-constrained trades (without moving real money).
- Produces holdings/transactions CSV output for the importer script and a run report.

To invoke it in Codex, ask for a run and provide the sheet URL, for example:

```text
Run the Portfolio Simulator skill using this sheet:
https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit
```

Minimum input is the Google Sheet URL; the skill extracts the spreadsheet ID from that link and uses it as the run source.
