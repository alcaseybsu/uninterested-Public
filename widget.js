/**
 * widget.js
 * uninterested — Scriptable home screen widget
 *
 * Reads card, bill, and settings data from iCloud JSON files,
 * syncs current balances from YNAB, calculates payment splits,
 * and builds the home screen widget display.
 *
 * This is the entry point Scriptable calls automatically
 * when the widget refreshes or is previewed manually.
 *
 * Depends on: sanitizer.js, calculator.js, bills.js, setup.js
 */

const { calculateCardSplits, calculateBillSplits, calculateWeeklyTotals } = require("./calculator");
const { checkOverdueBills, getAllBillSplits } = require("./bills");
const { sanitizeObject } = require("./sanitizer");

// ─────────────────────────────────────────
// ICLOUD FILE PATHS
// ─────────────────────────────────────────

/** @constant {FileManager} FILE_MANAGER - Scriptable iCloud file manager */
const FILE_MANAGER = FileManager.iCloud();

/** @constant {string} BASE_PATH - Root documents directory in iCloud */
const BASE_PATH = FILE_MANAGER.documentsDirectory();

/** @constant {string} CARDS_PATH - Path to stored card configurations */
const CARDS_PATH = `${BASE_PATH}/uninterested_cards.json`;

/** @constant {string} BILLS_PATH - Path to stored bill configurations */
const BILLS_PATH = `${BASE_PATH}/uninterested_bills.json`;

/** @constant {string} SETTINGS_PATH - Path to stored user settings */
const SETTINGS_PATH = `${BASE_PATH}/uninterested_settings.json`;

// ─────────────────────────────────────────
// ICLOUD READ / WRITE
// ─────────────────────────────────────────

/**
 * Read and parse a JSON file from iCloud.
 * Returns null if the file does not exist or cannot be parsed.
 *
 * @param {string} path - Full iCloud file path
 * @returns {Object|Array|null}
 */
function readJSON(path) {
  try {
    if (!FILE_MANAGER.fileExists(path)) return null;
    const raw = FILE_MANAGER.readString(path);
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

/**
 * Serialize and write an object to iCloud as a JSON file.
 * Silently logs an error if the write fails.
 *
 * @param {string} path - Full iCloud file path
 * @param {Object|Array} data - Data to store
 * @returns {void}
 */
function writeJSON(path, data) {
  try {
    FILE_MANAGER.writeString(path, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Failed to write file:", path, err);
  }
}

// ─────────────────────────────────────────
// YNAB SYNC
// ─────────────────────────────────────────

/** @constant {string} YNAB_API_BASE - Base URL for all YNAB API requests */
const YNAB_API_BASE = "https://api.youneedabudget.com/v1";

/**
 * Sync current balances from YNAB for all configured cards.
 * Only updates the currentBalance field — never modifies
 * nicknames, cycle configuration, or any other card data.
 *
 * Returns the unmodified cards array silently if offline,
 * if the token is missing, or if YNAB returns an error.
 *
 * Note: YNAB stores all amounts in milliunits (1000 = $1.00).
 *
 * @param {Object[]} cards - Configured card objects from iCloud
 * @param {string} token - YNAB personal access token from Keychain
 * @returns {Promise<Object[]>} - Cards with updated currentBalance values
 */
async function syncYNABBalances(cards, token) {
  try {
    const response = await fetch(`${YNAB_API_BASE}/budgets/default/accounts`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) return cards; // silently return unmodified on API error

    const data = await response.json();
    const accounts = data.data.accounts;

    return cards.map((card) => {
      const match = accounts.find((a) => a.id === card.ynabId);
      if (!match) return card;

      return {
        ...card,
        currentBalance: Math.abs(match.balance / 1000), // milliunits to dollars
      };
    });
  } catch (err) {
    return cards; // return unmodified if offline or fetch fails
  }
}

// ─────────────────────────────────────────
// CYCLE CALCULATIONS
// ─────────────────────────────────────────

/**
 * Calculate the next payment due date for a card
 * based on its closing day and due days configuration.
 *
 * Logic:
 *   - If the closing day has already passed this month,
 *     the next due date is calculated from this month's closing.
 *   - If the closing day has not yet occurred this month,
 *     it is calculated from last month's closing.
 *
 * @param {Object} card - Card with closingDay and dueDaysAfterClosing
 * @param {number} card.closingDay - Day of month statement closes (1-31)
 * @param {number} card.dueDaysAfterClosing - Days after closing payment is due
 * @returns {string} - Due date as "YYYY-MM-DD"
 */
function calculateNextDueDate(card) {
  const today = new Date();
  const currentMonth = today.getMonth();
  const currentYear = today.getFullYear();

  // Find the most recent closing date
  let closingDate = new Date(currentYear, currentMonth, card.closingDay);
  if (closingDate > today) {
    // Closing hasn't happened yet this month — use last month's closing
    closingDate = new Date(currentYear, currentMonth - 1, card.closingDay);
  }

  // Due date = closing date + dueDaysAfterClosing
  const dueDate = new Date(closingDate);
  dueDate.setDate(dueDate.getDate() + card.dueDaysAfterClosing);

  return dueDate.toISOString().split("T")[0];
}

/**
 * Calculate the statement balance for a card from YNAB transaction history.
 * Sums all cleared (posted) transactions since the last closing date.
 * Pending transactions are excluded — they belong to the next cycle.
 *
 * Note: YNAB stores all amounts in milliunits (1000 = $1.00).
 *
 * @param {string} ynabId - YNAB account UUID
 * @param {string} closingDate - Last closing date as "YYYY-MM-DD"
 * @param {string} token - YNAB personal access token from Keychain
 * @returns {Promise<number>} - Statement balance in dollars, rounded to 2 decimal places
 */
async function calculateStatementBalance(ynabId, closingDate, token) {
  try {
    const response = await fetch(
      `${YNAB_API_BASE}/budgets/default/accounts/${ynabId}/transactions?since_date=${closingDate}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!response.ok) return 0;

    const data = await response.json();
    const transactions = data.data.transactions;

    // Sum only cleared transactions (exclude pending)
    const total = transactions
      .filter((t) => t.cleared === "cleared")
      .reduce((sum, t) => sum + Math.abs(t.amount), 0);

    return Math.round((total / 1000) * 100) / 100; // milliunits to dollars
  } catch (err) {
    return 0;
  }
}

// ─────────────────────────────────────────
// WIDGET COLORS
// ─────────────────────────────────────────

/**
 * Color palette for the widget display.
 * All colors use hex values compatible with Scriptable's Color class.
 * @type {Object.<string, Color>}
 */
const COLORS = {
  background: new Color("#1a1a2e"),  // dark navy — widget background
  cardHeader:  new Color("#16213e"), // slightly lighter navy — section headers
  accent:      new Color("#0f3460"), // deep blue — accent elements
  urgent:      new Color("#e94560"), // red — urgent payments and warnings
  text:        new Color("#ffffff"), // white — primary text
  subtext:     new Color("#a8a8b3"), // grey — secondary text and labels
  credit:      new Color("#4cc9f0"), // blue — credit card amounts
  bill:        new Color("#7bed9f"), // green — bill amounts
  total:       new Color("#ffd60a"), // yellow — grand totals
  divider:     new Color("#2d2d44"), // dark — divider lines between weeks
};

// ─────────────────────────────────────────
// WIDGET BUILDER
// ─────────────────────────────────────────

/**
 * Build the complete Scriptable widget.
 *
 * Display order:
 *   1. Header ("💳 uninterested")
 *   2. Setup incomplete warning (if setupComplete is false)
 *   3. Urgent items (cards or bills with no paydays remaining)
 *   4. Unverified card warnings
 *   5. Weekly breakdown (up to 3 upcoming paydays):
 *        - Credit card rows + subtotal
 *        - Bill rows + subtotal
 *        - Grand total for that payday
 *   6. Last synced date
 *
 * @param {Object[]} cards - Configured card objects from iCloud
 * @param {Object[]} bills - Configured bill objects from iCloud
 * @param {Object} settings - User settings from iCloud
 * @returns {Promise<ListWidget>}
 */
async function buildWidget(cards, bills, settings) {
  const widget = new ListWidget();
  widget.backgroundColor = COLORS.background;
  widget.setPadding(12, 12, 12, 12);

  // ── Header ──
  const header = widget.addText("💳 uninterested");
  header.textColor = COLORS.text;
  header.font = Font.boldSystemFont(14);
  widget.addSpacer(6);

  // ── Setup incomplete warning ──
  if (!settings || !settings.setupComplete) {
    const msg = widget.addText("Setup not complete. Open the app to finish setup.");
    msg.textColor = COLORS.urgent;
    msg.font = Font.systemFont(12);
    return widget;
  }

  // ── Sync YNAB balances ──
  // Token is stored in iOS Keychain, never in a file
  const token = Keychain.get("uninterested_ynab_token");
  const syncedCards = token ? await syncYNABBalances(cards, token) : cards;

  // ── Calculate due dates and splits for all verified cards ──
  const cardSplits = syncedCards
    .filter((c) => c.verified)
    .map((card) => {
      const dueDate = calculateNextDueDate(card);
      return calculateCardSplits(
        {
          nickname: card.nickname,
          statementBalance: card.statementBalance || card.currentBalance,
          dueDate,
        },
        { paydayName: settings.paydayName }
      );
    });

  // ── Check overdue bills and get splits for all active bills ──
  const checkedBills = checkOverdueBills(bills || []);
  const billSplits = getAllBillSplits(checkedBills, { paydayName: settings.paydayName });

  // ── Combine into per-payday totals ──
  const allSplits = [...cardSplits, ...billSplits];
  const weeklyTotals = calculateWeeklyTotals(allSplits);

  // ── Collect urgent items (no paydays remaining) ──
  const urgentCards = cardSplits.filter((c) => c.urgent);
  const urgentBills = billSplits.filter((b) => b.urgent);
  const allUrgent = [...urgentCards, ...urgentBills];

  // ── Display urgent items ──
  if (allUrgent.length > 0) {
    const urgentHeader = widget.addText("⚠️ URGENT");
    urgentHeader.textColor = COLORS.urgent;
    urgentHeader.font = Font.boldSystemFont(11);
    widget.addSpacer(2);

    for (const item of allUrgent) {
      const row = widget.addStack();
      row.layoutHorizontally();

      const name = row.addText(item.nickname);
      name.textColor = COLORS.urgent;
      name.font = Font.systemFont(11);
      row.addSpacer();

      const amount = row.addText(`$${item.fullAmountDue.toFixed(2)}`);
      amount.textColor = COLORS.urgent;
      amount.font = Font.boldSystemFont(11);
    }

    widget.addSpacer(6);
  }

  // ── Display unverified card warnings ──
  const unverified = syncedCards.filter((c) => !c.verified || c.snoozedVerification);
  for (const card of unverified) {
    const msg = widget.addText(
      `${card.nickname}: Please verify your due date to continue tracking this card.`
    );
    msg.textColor = COLORS.urgent;
    msg.font = Font.italicSystemFont(10);
    widget.addSpacer(2);
  }

  // ── Display weekly breakdown (max 3 paydays) ──
  const weeksToShow = Math.min(weeklyTotals.length, 3);

  for (let i = 0; i < weeksToShow; i++) {
    const week = weeklyTotals[i];
    const isThisWeek = i === 0;

    // Week header row with payday label and grand total
    const weekLabel = isThisWeek
      ? `THIS ${settings.paydayName.toUpperCase()}`
      : `${week.date}`;

    const weekHeader = widget.addStack();
    weekHeader.layoutHorizontally();

    const weekTitle = weekHeader.addText(weekLabel);
    weekTitle.textColor = COLORS.text;
    weekTitle.font = Font.boldSystemFont(11);
    weekHeader.addSpacer();

    const weekTotal = weekHeader.addText(`$${week.total.toFixed(2)}`);
    weekTotal.textColor = COLORS.total;
    weekTotal.font = Font.boldSystemFont(11);

    widget.addSpacer(2);

    // ── Credit card rows ──
    if (week.cards.length > 0) {
      const creditLabel = widget.addText("💳 CARDS");
      creditLabel.textColor = COLORS.credit;
      creditLabel.font = Font.boldSystemFont(9);

      for (const card of week.cards) {
        const row = widget.addStack();
        row.layoutHorizontally();

        const name = row.addText(`  ${card.nickname}`);
        name.textColor = COLORS.subtext;
        name.font = Font.systemFont(10);
        row.addSpacer();

        const amt = row.addText(`$${card.amount.toFixed(2)}`);
        amt.textColor = COLORS.credit;
        amt.font = Font.systemFont(10);
      }

      // Card subtotal row
      const subtotalRow = widget.addStack();
      subtotalRow.layoutHorizontally();

      const subtotalLabel = subtotalRow.addText("  Subtotal");
      subtotalLabel.textColor = COLORS.subtext;
      subtotalLabel.font = Font.italicSystemFont(9);
      subtotalRow.addSpacer();

      const subtotalAmt = subtotalRow.addText(`$${week.cardSubtotal.toFixed(2)}`);
      subtotalAmt.textColor = COLORS.credit;
      subtotalAmt.font = Font.italicSystemFont(9);
    }

    // ── Bill rows ──
    if (week.bills.length > 0) {
      const billLabel = widget.addText("🧾 BILLS");
      billLabel.textColor = COLORS.bill;
      billLabel.font = Font.boldSystemFont(9);

      for (const bill of week.bills) {
        const row = widget.addStack();
        row.layoutHorizontally();

        const name = row.addText(`  ${bill.nickname}`);
        name.textColor = COLORS.subtext;
        name.font = Font.systemFont(10);
        row.addSpacer();

        const amt = row.addText(`$${bill.amount.toFixed(2)}`);
        amt.textColor = COLORS.bill;
        amt.font = Font.systemFont(10);
      }

      // Bill subtotal row
      const subtotalRow = widget.addStack();
      subtotalRow.layoutHorizontally();

      const subtotalLabel = subtotalRow.addText("  Subtotal");
      subtotalLabel.textColor = COLORS.subtext;
      subtotalLabel.font = Font.italicSystemFont(9);
      subtotalRow.addSpacer();

      const subtotalAmt = subtotalRow.addText(`$${week.billSubtotal.toFixed(2)}`);
      subtotalAmt.textColor = COLORS.bill;
      subtotalAmt.font = Font.italicSystemFont(9);
    }

    // Divider between weeks (not after the last one)
    if (i < weeksToShow - 1) {
      widget.addSpacer(4);
      const divider = widget.addText("─────────────────────");
      divider.textColor = COLORS.divider;
      divider.font = Font.systemFont(8);
      widget.addSpacer(4);
    }
  }

  // ── Last synced date ──
  widget.addSpacer(6);
  const syncLabel = widget.addText(`Synced: ${settings.lastSyncDate || "never"}`);
  syncLabel.textColor = COLORS.subtext;
  syncLabel.font = Font.systemFont(8);

  return widget;
}

// ─────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────

/**
 * Main entry point called by Scriptable automatically.
 *
 * Loads all data from iCloud, builds the widget, and either:
 *   - Sets it as the home screen widget (when running as widget)
 *   - Presents it full size for preview (when run manually)
 *
 * @returns {Promise<void>}
 */
async function run() {
  const cards = readJSON(CARDS_PATH) || [];
  const bills = readJSON(BILLS_PATH) || [];
  const settings = readJSON(SETTINGS_PATH);

  const widget = await buildWidget(cards, bills, settings);

  if (config.runsInWidget) {
    Script.setWidget(widget);
  } else {
    // Running manually in Scriptable — show full preview
    widget.presentLarge();
  }

  Script.complete();
}

run();