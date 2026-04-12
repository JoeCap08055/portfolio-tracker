// ============================================================
//  Cheo Portfolio Simulator — Google Apps Script
//  Auto-imports Holdings + Transactions CSVs from Gmail,
//  applies formulas, formats the Holdings Totals row.
//  Updated: 2026-04-10
// ============================================================

var SHEET_ID      = "1fZBgEP_U01ACWTupPsTKW9sxYCoEJgPXmB_qS9HoxTg";
var EMAIL_SUBJECT = "Portfolio Simulation Results";
var LABEL_NAME    = "cheo-imported";

// ── Column maps (1-based) ────────────────────────────────────

// Holdings: Asset|Class|Quantity|Avg_Cost|Current_Price|Market_Value|Allocation_Pct|Unrealized_PL|Price_Source
var H_QUANTITY       = 3;
var H_CURRENT_PRICE  = 5;
var H_MARKET_VALUE   = 6;
var H_ALLOCATION_PCT = 7;

// Transactions: Timestamp|Type|Ticker|Name|Class|Quantity|Price|Total|Fees|Net Amount|Realized P&L|Source|Account|Notes
var T_TYPE       = 2;  // BUY or SELL
var T_QUANTITY   = 5;
var T_PRICE      = 6;
var T_TOTAL      = 7;
var T_FEES       = 8;
var T_NET_AMOUNT = 9;

function columnLetter(c) {
    return String.fromCharCode('A'.charCodeAt() + c - 1);
}

// ============================================================
//  MAIN: Check Gmail for new simulation emails
// ============================================================
function checkForSimulationEmail() {
    var threads = GmailApp.search('subject:"' + EMAIL_SUBJECT + '" is:unread -label:' + LABEL_NAME);
    if (threads.length === 0) return;

    // Ensure label exists
    var label = GmailApp.getUserLabelByName(LABEL_NAME);
    if (!label) label = GmailApp.createLabel(LABEL_NAME);

    var ss = SpreadsheetApp.openById(SHEET_ID);

    for (var i = 0; i < threads.length; i++) {
        var thread  = threads[i];
        var message = thread.getMessages()[thread.getMessages().length - 1]; // latest message
        var body    = message.getPlainBody();

        var holdingsCSV     = extractBlock(body, "HOLDINGS CSV");
        var transactionsCSV = extractBlock(body, "TRANSACTIONS CSV");

        if (holdingsCSV)     importHoldings(ss, holdingsCSV);
        if (transactionsCSV) importTransactions(ss, transactionsCSV);

        // Mark processed
        thread.markRead();
        label.addToThread(thread);
    }

    sendConfirmationEmail();
}

function reformatSpreadsheet() {
    var ss = SpreadsheetApp.openById(SHEET_ID);

    var holdingsSheet = ss.getSheetByName("Holdings");
    if (holdingsSheet) {
        deleteTotalsRows(holdingsSheet);
        var numRows = holdingsSheet.getLastRow();
        var numCols = holdingsSheet.getLastColumn();
        applyHoldingsFormulas(holdingsSheet, numRows, numCols);
    }

    var transactionsSheet = ss.getSheetByName("Transactions");
    if (transactionsSheet) {
        applyTransactionFormulas(transactionsSheet, transactionsSheet.getLastRow() - 1);
    }
}

function deleteTotalsRows(sheet) {
    const range = sheet.getDataRange();
    const values = range.getValues();

    // Loop from bottom to top to avoid index shifting when deleting
    for (let i = values.length - 1; i >= 0; i--) {
        if (values[i][0] === "TOTALS") {
            sheet.deleteRow(i + 1); // +1 because sheet rows are 1-based
        }
    }
}

// ============================================================
//  Extract a CSV block from email body
//  Looks for:  === LABEL CSV ===  ...  === END LABEL CSV ===
// ============================================================
function extractBlock(body, label) {
    var startTag = "=== " + label + " ===";
    var endTag   = "=== END " + label + " ===";
    var start    = body.indexOf(startTag);
    var end      = body.indexOf(endTag);
    if (start === -1 || end === -1) return null;
    return body.substring(start + startTag.length, end).trim();
}

// ============================================================
//  HOLDINGS — Replace sheet, then apply formulas + Totals row
// ============================================================
function importHoldings(ss, csvText) {
    var sheet = ss.getSheetByName("Holdings");
    if (!sheet) sheet = ss.insertSheet("Holdings");

    var rows = parseCSV(csvText);
    if (rows.length === 0) return;

    // Strip any trailing TOTALS row that came from the CSV
    // (Apps Script will re-create it cleanly)
    var dataRows = [];
    for (var i = 0; i < rows.length; i++) {
        if (rows[i][0] && rows[i][0].toString().toUpperCase() === "TOTALS") continue;
        dataRows.push(rows[i]);
    }

    // Clear and write raw data
    sheet.clearContents();
    sheet.clearFormats();

    var numRows = dataRows.length;
    var numCols = dataRows[0].length;
    sheet.getRange(1, 1, numRows, numCols).setValues(dataRows);

    // Header row formatting
    var headerRange = sheet.getRange(1, 1, 1, numCols);
    headerRange.setFontWeight("bold");
    headerRange.setBackground("#1a1a2e");
    headerRange.setFontColor("#ffffff");

    applyHoldingsFormulas(sheet, numRows, numCols);

    // Auto-resize columns
    sheet.autoResizeColumns(1, numCols);
}

// ============================================================
// HOLDINGS - Apply formulas
// ============================================================
function applyHoldingsFormulas(sheet, numRows, numCols) {
    // Apply formulas to data rows (skip header row = row 1)
    // Total Market Value reference for Allocation_Pct
    // We use a helper column-less approach: SUM of Market_Value column
    var lastDataRow = numRows; // last row of actual data (header is row 1, data starts row 2)

    for (var r = 2; r <= numRows; r++) {
        // Market_Value = Current_Price * Quantity
        var pc = columnLetter(H_CURRENT_PRICE);
        var qc = columnLetter(H_QUANTITY);
        sheet.getRange(r, H_MARKET_VALUE)
            .setFormula(`=${pc}${r}*${qc}${r}`);

        // Allocation_Pct = Market_Value / SUM(Market_Value column) — formatted as %
        var mc = columnLetter(H_MARKET_VALUE);
        sheet.getRange(r, H_ALLOCATION_PCT)
            .setFormula(`=${mc}${r}/SUM($${mc}$2:$${mc}$${lastDataRow})`);
    }

    // Format Allocation_Pct column as percentage
    sheet.getRange(2, H_ALLOCATION_PCT, numRows - 1, 1).setNumberFormat("0.00%");

    // Format Market_Value and Unrealized_PL as currency
    sheet.getRange(2, H_MARKET_VALUE,   numRows - 1, 1).setNumberFormat("$#,##0.00");
    sheet.getRange(2, 4,                numRows - 1, 1).setNumberFormat("$#,##0.00"); // Avg_Cost
    sheet.getRange(2, H_CURRENT_PRICE,  numRows - 1, 1).setNumberFormat("$#,##0.00"); // Current_Price

    // ── Totals Row ────────────────────────────────────────────
    var totalsRow = numRows + 1;

    sheet.getRange(totalsRow, 1).setValue("TOTALS");

    // Market_Value sum
    var mc = columnLetter(H_MARKET_VALUE);
    sheet.getRange(totalsRow, H_MARKET_VALUE)
        .setFormula(`=SUM(${mc}2:${mc}${numRows})`);

    // Allocation_Pct sum (should equal 100%)
    var ac = columnLetter(H_ALLOCATION_PCT);
    sheet.getRange(totalsRow, H_ALLOCATION_PCT)
        .setFormula(`=SUM(${ac}2:${ac}${numRows})`);

    // Format Totals row
    var totalsRange = sheet.getRange(totalsRow, 1, 1, numCols);
    totalsRange.setFontWeight("bold");
    totalsRange.setBackground("#0f3460");
    totalsRange.setFontColor("#ffffff");
    totalsRange.setBorder(true, false, false, false, false, false, "#e94560", SpreadsheetApp.BorderStyle.SOLID_MEDIUM);

    sheet.getRange(totalsRow, H_MARKET_VALUE).setNumberFormat("$#,##0.00");
    sheet.getRange(totalsRow, H_ALLOCATION_PCT).setNumberFormat("0.00%");
}

// ============================================================
//  TRANSACTIONS — Append new rows, apply formulas
// ============================================================
function importTransactions(ss, csvText) {
    var sheet = ss.getSheetByName("Transactions");
    if (!sheet) sheet = ss.insertSheet("Transactions");

    var rows = parseCSV(csvText);
    if (rows.length === 0) return;

    var existingRows = sheet.getLastRow();

    // If sheet is empty, write header row first
    if (existingRows === 0) {
        sheet.appendRow(rows[0]);
        var headerRange = sheet.getRange(1, 1, 1, rows[0].length);
        headerRange.setFontWeight("bold");
        headerRange.setBackground("#1a1a2e");
        headerRange.setFontColor("#ffffff");
        existingRows = 1;
    }

    // Collect existing Timestamps to prevent duplicate imports
    var existingTimestamps = {};
    if (existingRows > 1) {
        var tsCol = sheet.getRange(2, 1, existingRows - 1, 1).getValues();
        for (var i = 0; i < tsCol.length; i++) {
            existingTimestamps[tsCol[i][0].toString().trim()] = true;
        }
    }

    // Append data rows (skip header row[0])
    var newRowStart = sheet.getLastRow() + 1;
    var appendedCount = 0;

    for (var r = 1; r < rows.length; r++) {
        var row = rows[r];
        var ts  = row[0] ? row[0].toString().trim() : "";
        if (!ts || existingTimestamps[ts]) continue; // skip duplicates

        sheet.appendRow(row);
        appendedCount++;
    }

    if (appendedCount === 0) return; // nothing new to format

    applyTransactionFormulas(sheet, appendedCount);

    sheet.autoResizeColumns(1, sheet.getLastColumn());
}

function applyTransactionFormulas(sheet, appendedCount) {
    if (appendedCount <= 0) {
        return;
    }
    // Apply formulas to the newly appended rows
    var lastRow = sheet.getLastRow();
    var firstNewRow = lastRow - appendedCount + 1;

    sheet.getRange(lastRow, 1, 1, sheet.getLastColumn()).setBorder(
        false,   // top
        false,  // left
        true,  // bottom
        false,  // right
        false,  // vertical
        false,  // horizontal
        "black",
        SpreadsheetApp.BorderStyle.SOLID_THICK
    );

    for (var row = firstNewRow; row <= lastRow; row++) {
        // Total = Quantity * Price
        var qc = columnLetter(T_QUANTITY);
        var pc = columnLetter(T_PRICE);
        sheet.getRange(row, T_TOTAL)
            .setFormula(`=${qc}${row}*${pc}${row}`);

        // Net Amount = (Total * Direction) - Fees
        var tc = columnLetter(T_TOTAL);
        var bsc = columnLetter(T_TYPE);
        var fc = columnLetter(T_FEES);
        // Direction: IF(Type="BUY", -1, 1)
        sheet.getRange(row, T_NET_AMOUNT)
            .setFormula(`=(abs(${tc}${row})*IF(${bsc}${row}="BUY",-1,1))-${fc}${row}`);
    }

    // Format numeric columns
    sheet.getRange(firstNewRow, T_PRICE,      appendedCount, 1).setNumberFormat("$#,##0.00");
    sheet.getRange(firstNewRow, T_TOTAL,      appendedCount, 1).setNumberFormat("$#,##0.00");
    sheet.getRange(firstNewRow, T_FEES,       appendedCount, 1).setNumberFormat("$#,##0.00");
    sheet.getRange(firstNewRow, T_NET_AMOUNT, appendedCount, 1).setNumberFormat("$#,##0.00");
    sheet.getRange(firstNewRow, 11,           appendedCount, 1).setNumberFormat("$#,##0.00"); // Realized P&L

    // Alternate row shading for readability
    for (var row = firstNewRow; row <= lastRow; row++) {
        if (row % 2 === 0) {
            sheet.getRange(row, 1, 1, sheet.getLastColumn()).setBackground("#dddddd");
        }
    }
}

// ============================================================
//  CSV Parser — handles quoted fields with commas
// ============================================================
function parseCSV(text) {
    var rows   = [];
    var lines  = text.split("\n");
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;
        rows.push(parseCSVLine(line));
    }
    return rows;
}

function parseCSVLine(line) {
    var result  = [];
    var current = "";
    var inQuote = false;
    for (var i = 0; i < line.length; i++) {
        var ch = line[i];
        if (ch === '"') {
            inQuote = !inQuote;
        } else if (ch === "," && !inQuote) {
            result.push(current.trim());
            current = "";
        } else {
            current += ch;
        }
    }
    result.push(current.trim());
    return result;
}

// ============================================================
//  Send confirmation email back to user
// ============================================================
function sendConfirmationEmail() {
    GmailApp.sendEmail(
        "joseph.caputo@projectliberty.io",
        "✅ Portfolio Sheet Updated — Cheo Import Complete",
        "Your Google Sheet has been updated successfully by the Cheo Portfolio Simulator auto-import script.\n\n" +
        "• Holdings tab: replaced with latest simulation data + formulas applied\n" +
        "• Transactions tab: new rows appended + formulas applied\n" +
        "• Holdings Totals row: refreshed at the bottom\n\n" +
        "View your sheet: https://docs.google.com/spreadsheets/d/" + SHEET_ID + "\n\n" +
        "— Cheo Auto-Import"
    );
}

// ============================================================
//  SETUP — Run once to verify permissions & label
// ============================================================
function setup() {
    var label = GmailApp.getUserLabelByName(LABEL_NAME);
    if (!label) {
        GmailApp.createLabel(LABEL_NAME);
        Logger.log("Created Gmail label: " + LABEL_NAME);
    } else {
        Logger.log("Label already exists: " + LABEL_NAME);
    }
    var ss = SpreadsheetApp.openById(SHEET_ID);
    Logger.log("Sheet access OK: " + ss.getName());
    Logger.log("Setup complete. Now add a time-driven trigger for checkForSimulationEmail.");
}
