/**
 * widget_scriptable.js
 * uninterested — Home screen widget (Scriptable version)
 *
 * This is the combined single-file version for use in Scriptable.
 * All functions from sanitizer.js, calculator.js, bills.js,
 * and widget.js are included here — no require() calls needed.
 *
 * Reads card, bill, and settings data from iCloud,
 * syncs balances from YNAB, and displays your payment splits.
 *
 * In Scriptable, name this script: widget
 */

// ─────────────────────────────────────────
// SANITIZER
// ─────────────────────────────────────────

const PII_PATTERNS = [
  /\b(?:\d[ -]?){13,19}\b/g,
  /\b\d{3}[-]\d{2}[-]\d{4}\b/g,
  /(\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})/g,
  /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
  /\b\d{1,5}\s+\w+\s+(street|st|avenue|ave|road|rd|blvd|boulevard|drive|dr|lane|ln|way|court|ct)\b/gi,
  /\b\d{5}(?:[-]\d{4})?\b/g,
  /\b(account holder|cardholder|member name|name|customer)[:\s]+[A-Z][a-z]+\s+[A-Z][a-z]+/gi,
];

function scrubString(value) {
  if (typeof value !== "string") return value;
  let scrubbed = value;
  for (const pattern of PII_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, "[removed]");
  }
  return scrubbed;
}

// ─────────────────────────────────────────
// CALCULATOR
// ─────────────────────────────────────────

const DAY_NAME_TO_INDEX = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

function getToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatDate(date) {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function round(amount) {
  return Math.round(amount * 100) / 100;
}

// ── Weekly paydays between today and due date ──
// If today IS the payday, include today (don't skip to next week)
function getWeeklyPaydaysBefore(dueDate, paydayName = "thursday") {
  const paydays = [];
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);

  const targetDay = DAY_NAME_TO_INDEX[paydayName.toLowerCase()];
  if (targetDay === undefined) return [];

  const cursor = new Date(getToday());
  const daysUntilPayday = (targetDay - cursor.getDay() + 7) % 7;
  // daysUntilPayday === 0 means today IS the payday — include it
  cursor.setDate(cursor.getDate() + daysUntilPayday);

  while (cursor <= due) {
    paydays.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 7);
  }
  return paydays;
}

// ── Biweekly paydays (every other week) ──
function getBiweeklyPaydaysBefore(dueDate, paydayName = "thursday") {
  return getWeeklyPaydaysBefore(dueDate, paydayName).filter((_, i) => i % 2 === 0);
}

// ── Monthly payday — one payment on a fixed day of the month ──
function getMonthlyPaydayBefore(dueDate, paydayOfMonth = 1) {
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  const today = getToday();

  // Find next occurrence of paydayOfMonth on or after today
  let candidate = new Date(today.getFullYear(), today.getMonth(), paydayOfMonth);
  if (candidate < today) {
    candidate = new Date(today.getFullYear(), today.getMonth() + 1, paydayOfMonth);
  }

  // Only return it if it falls on or before the due date
  if (candidate <= due) return [candidate];
  return [];
}

// ── Filter out skipped pay periods ──
// skippedDates: array of "YYYY-MM-DD" strings
function removeSkippedPaydays(paydays, skippedDates = []) {
  if (!skippedDates || skippedDates.length === 0) return paydays;
  const skippedSet = new Set(skippedDates.map((d) => d));
  return paydays.filter((date) => {
    const dateStr = date.toISOString().split("T")[0];
    return !skippedSet.has(dateStr);
  });
}

// ── Resolve payment dates based on frequency setting ──
// Reads from item-level override first, falls back to global settings
// Also removes any pay periods marked as skipped
function resolvePaydays(dueDate, itemSettings, globalSettings) {
  const frequency =
    itemSettings.paymentFrequency ||
    globalSettings.paymentFrequency ||
    "weekly";

  const skippedDates = globalSettings.skippedPayPeriods
    ? globalSettings.skippedPayPeriods.map((s) => s.date)
    : [];

  if (frequency === "monthly") {
    const paydayOfMonth =
      itemSettings.paydayOfMonth ||
      globalSettings.paydayOfMonth ||
      1;
    const paydays = removeSkippedPaydays(
      getMonthlyPaydayBefore(dueDate, paydayOfMonth),
      skippedDates
    );
    return { paydays, frequency };
  }

  const paydayName =
    itemSettings.paydayName ||
    globalSettings.paydayName ||
    "thursday";

  if (frequency === "biweekly") {
    const paydays = removeSkippedPaydays(
      getBiweeklyPaydaysBefore(dueDate, paydayName),
      skippedDates
    );
    return { paydays, frequency };
  }

  // Default: weekly
  const paydays = removeSkippedPaydays(
    getWeeklyPaydaysBefore(dueDate, paydayName),
    skippedDates
  );
  return { paydays, frequency };
}

// ── Split a balance across resolved paydays ──
function splitBalance(balance, paydays) {
  if (paydays.length === 0) return [];
  const amountPerPayday = round(balance / paydays.length);
  return paydays.map((date, index) => {
    const isLast = index === paydays.length - 1;
    const amount = isLast
      ? round(balance - amountPerPayday * (paydays.length - 1))
      : amountPerPayday;
    return { date: formatDate(date), rawDate: date, amount };
  });
}

function calculateCardSplits(cardData, globalSettings = {}) {
  const { nickname, statementBalance, dueDate } = cardData;
  const balance = parseFloat(statementBalance);

  // Card-level overrides take priority over global settings
  const itemSettings = {
    paymentFrequency: cardData.paymentFrequency,
    paydayName: cardData.paydayName,
    paydayOfMonth: cardData.paydayOfMonth,
  };

  const { paydays, frequency } = resolvePaydays(dueDate, itemSettings, globalSettings);

  if (paydays.length === 0) {
    return {
      nickname, type: "credit", urgent: true,
      message: "Please verify your due date to continue tracking this card.",
      fullAmountDue: round(balance), dueDate, splits: [],
    };
  }

  const splits = splitBalance(balance, paydays);
  return {
    nickname, type: "credit", urgent: false,
    statementBalance: round(balance), dueDate,
    frequency, paydayCount: paydays.length,
    amountPerPayday: splits[0]?.amount, splits,
  };
}

function calculateBillSplits(billData, globalSettings = {}) {
  const { nickname, amount, dueDate } = billData;
  const balance = parseFloat(amount);

  const itemSettings = {
    paymentFrequency: billData.paymentFrequency,
    paydayName: billData.paydayName,
    paydayOfMonth: billData.paydayOfMonth,
  };

  const { paydays, frequency } = resolvePaydays(dueDate, itemSettings, globalSettings);

  if (paydays.length === 0) {
    return {
      nickname, type: "bill", urgent: true,
      message: `${nickname} is due soon — pay when you can.`,
      fullAmountDue: round(balance), dueDate, splits: [],
    };
  }

  const splits = splitBalance(balance, paydays);
  return {
    nickname, type: "bill", urgent: false,
    amount: round(balance), dueDate, frequency,
    paydayCount: paydays.length,
    amountPerPayday: splits[0]?.amount, splits,
  };
}

function calculateWeeklyTotals(allSplitResults) {
  const totals = {};

  for (const result of allSplitResults) {
    if (result.urgent) continue;
    for (const split of result.splits) {
      const key = split.date;
      if (!totals[key]) {
        totals[key] = {
          date: split.date, rawDate: split.rawDate,
          cards: [], bills: [],
          cardSubtotal: 0, billSubtotal: 0, total: 0,
        };
      }
      if (result.type === "credit") {
        // Include paid splits in display but not in totals
        const displayAmount = split.paid ? 0 : split.amount;
        totals[key].cards.push({
          nickname: result.nickname,
          amount: displayAmount,
          originalAmount: split.originalAmount || split.amount,
          paid: split.paid || false,
          partiallyPaid: split.partiallyPaid || false,
          paidAmount: split.paidAmount || 0,
        });
        totals[key].cardSubtotal = round(totals[key].cardSubtotal + displayAmount);
      } else {
        totals[key].bills.push({ nickname: result.nickname, amount: split.amount });
        totals[key].billSubtotal = round(totals[key].billSubtotal + split.amount);
      }
      totals[key].total = round(totals[key].cardSubtotal + totals[key].billSubtotal);
    }
  }

  return Object.values(totals).sort((a, b) => a.rawDate - b.rawDate);
}

// ─────────────────────────────────────────
// LOCKED SPLITS
// Splits are calculated once per statement cycle
// and stored on the card. Not recalculated on refresh.
// ─────────────────────────────────────────

/**
 * Calculate and lock splits for a card for the current statement cycle.
 * Called when a new statement closes, or when no lockedSplits exist yet.
 * Returns an array of split objects with date, amount, paid, paidAmount.
 */
function calculateLockedSplits(card, globalSettings) {
  // ONLY use statementBalance — never currentBalance
  // currentBalance changes with every payment and is display-only
  // statementBalance is the locked amount from the last statement close
  const balance = parseFloat(card.statementBalance || 0);
  if (balance <= 0) return [];

  const dueDate = calculateNextDueDate(card);

  // Safety check: if due date is in the past, extend to next month's due date
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  if (due < today && card.dueDay) {
    // Due date already passed — skip to next month
    const nextDue = new Date(today.getFullYear(), today.getMonth() + 1, card.dueDay);
    console.log(`[uninterested] ${card.nickname}: due date ${dueDate} is in past, using ${nextDue.toISOString().split("T")[0]}`);
  }

  const itemSettings = {
    paymentFrequency: card.paymentFrequency,
    paydayName: card.paydayName,
    paydayOfMonth: card.paydayOfMonth,
  };

  const { paydays } = resolvePaydays(dueDate, itemSettings, globalSettings);
  if (paydays.length === 0) {
    console.log(`[uninterested] ${card.nickname}: no paydays found before due date ${dueDate}`);
    return [];
  }

  const splits = splitBalance(balance, paydays);
  return splits.map((s) => {
    const d = s.rawDate;
    // Use local date to avoid UTC offset shifting the date
    const dateKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    return {
      date: dateKey,
      amount: s.amount,
      paid: false,
      paidAmount: 0,
    };
  });
}

/**
 * Check if a card's locked splits need to be regenerated.
 * This happens when:
 *   - No lockedSplits exist yet
 *   - The statement has closed since splits were last calculated
 */
function splitsNeedRefresh(card) {
  // Only regenerate if no splits exist at all
  if (!card.lockedSplits || card.lockedSplits.length === 0) {
    // But only if we have a real statement balance to work from
    // Never regenerate from currentBalance (post-payment amount)
    return (card.statementBalance || 0) > 0;
  }

  // Only regenerate if a new statement has closed AFTER splits were locked
  // If splitLockedAt is missing, don't regenerate — keep existing splits
  if (!card.splitLockedAt) return false;

  // Only regenerate if lastStatementDate is set AND is newer than when splits were locked
  if (card.lastStatementDate && card.splitLockedAt) {
    const lockedAt = new Date(card.splitLockedAt);
    const lastStatement = new Date(card.lastStatementDate);
    if (lastStatement > lockedAt) return true;
  }

  return false;
}

/**
 * Get the previous pay period date (start of current pay window).
 * Used to determine which YNAB transactions count toward this period.
 */
function getPreviousPayday(currentPayday, frequency, paydayName, paydayOfMonth) {
  const d = new Date(currentPayday);
  if (frequency === "monthly") {
    d.setMonth(d.getMonth() - 1);
  } else if (frequency === "biweekly") {
    d.setDate(d.getDate() - 14);
  } else {
    d.setDate(d.getDate() - 7);
  }
  return d;
}

/**
 * Check YNAB transactions to see if any splits have been paid.
 * Marks splits as paid if payments >= split amount since last pay period.
 * If overpaid, redistributes remaining balance across future splits.
 */
async function checkAndUpdateSplitPayments(card, lockedSplits, token, budgetId, globalSettings) {
  if (!token || !budgetId || !lockedSplits || lockedSplits.length === 0) {
    return lockedSplits;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const frequency = card.paymentFrequency || globalSettings.paymentFrequency || "weekly";
  const paydayName = card.paydayName || globalSettings.paydayName || "thursday";
  const paydayOfMonth = card.paydayOfMonth || globalSettings.paydayOfMonth || 1;

  // Fetch recent YNAB transactions for this card
  // Look back far enough to cover the whole statement cycle
  const lookbackDate = card.lastStatementDate || 
    new Date(today.getFullYear(), today.getMonth() - 1, 1)
      .toISOString().split("T")[0];

  let transactions = [];
  try {
    const req = new Request(
      `https://api.youneedabudget.com/v1/budgets/${budgetId}/accounts/${card.ynabId}/transactions?since_date=${lookbackDate}`
    );
    req.headers = { Authorization: `Bearer ${token}` };
    const data = await req.loadJSON();
    transactions = data.data.transactions || [];
  } catch (e) {
    return lockedSplits; // return unmodified if offline
  }

  // Only count payments (negative amounts in YNAB = payments toward card)
  const payments = transactions.filter((t) => t.amount < 0);

  let updatedSplits = [...lockedSplits];
  let totalOverpaid = 0;

  for (let i = 0; i < updatedSplits.length; i++) {
    const split = updatedSplits[i];
    if (split.paid) continue;

    const splitDate = new Date(split.date);
    splitDate.setHours(0, 0, 0, 0);

    // Get the window: since previous pay period through this one
    const windowStart = getPreviousPayday(splitDate, frequency, paydayName, paydayOfMonth);
    windowStart.setHours(0, 0, 0, 0);

    // Sum payments in this window
    const windowPayments = payments.filter((t) => {
      const tDate = new Date(t.date);
      tDate.setHours(0, 0, 0, 0);
      return tDate >= windowStart && tDate <= splitDate;
    });

    const totalPaid = windowPayments.reduce((sum, t) => sum + Math.abs(t.amount / 1000), 0);

    if (totalPaid >= split.amount) {
      // Split is fully paid
      const overpaid = round(totalPaid - split.amount);
      updatedSplits[i] = { ...split, paid: true, paidAmount: round(totalPaid) };
      totalOverpaid += overpaid;
    } else if (totalPaid > 0) {
      // Partially paid
      updatedSplits[i] = { ...split, paidAmount: round(totalPaid) };
    }
  }

  // If overpaid, redistribute remaining balance across future unpaid splits
  if (totalOverpaid > 0) {
    const futureSplits = updatedSplits.filter((s) => !s.paid);
    if (futureSplits.length > 0) {
      const currentRemaining = futureSplits.reduce((sum, s) => sum + s.amount, 0);
      const newRemaining = round(currentRemaining - totalOverpaid);

      if (newRemaining <= 0) {
        // Overpaid everything — zero out future splits
        updatedSplits = updatedSplits.map((s) =>
          s.paid ? s : { ...s, amount: 0, paid: true, paidAmount: 0 }
        );
      } else {
        // Redistribute remaining across future splits
        const newAmountEach = round(newRemaining / futureSplits.length);
        let redistributed = 0;
        updatedSplits = updatedSplits.map((s, i) => {
          if (s.paid) return s;
          redistributed++;
          const isLast = redistributed === futureSplits.length;
          return {
            ...s,
            amount: isLast
              ? round(newRemaining - newAmountEach * (futureSplits.length - 1))
              : newAmountEach,
          };
        });
      }
    }
  }

  return updatedSplits;
}

// ─────────────────────────────────────────
// BUILD DISPLAY FROM LOCKED SPLITS
// ─────────────────────────────────────────

/**
 * Convert a card's lockedSplits into the display format
 * used by calculateWeeklyTotals and the widget/summary.
 * Marks paid splits with paid: true for strikethrough display.
 * Excludes fully paid splits from totals.
 */
function buildCardSplitFromLocked(card) {
  const lockedSplits = card.lockedSplits || [];

  // If no locked splits yet, return non-urgent placeholder
  // Splits will be generated on next refresh once statementBalance is set
  if (lockedSplits.length === 0) {
    const balance = card.statementBalance || 0;
    return {
      nickname: card.nickname,
      type: "credit",
      urgent: false,
      fullAmountDue: round(balance),
      statementBalance: balance,
      dueDate: card.nextDueDate || null,
      splits: [],
      lockedSplits: true,
      pendingSplitGeneration: true, // waiting for statementBalance to be set
    };
  }

  const splits = lockedSplits.map((s) => {
    // Parse date parts manually to avoid timezone offset shifting the date
    const [year, month, day] = s.date.split("-").map(Number);
    const rawDate = new Date(year, month - 1, day); // local midnight
    return {
      date: rawDate.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      rawDate,
      amount: s.paid ? 0 : round(s.amount - (s.paidAmount || 0)),
      originalAmount: s.amount,
      paid: s.paid,
      paidAmount: s.paidAmount || 0,
      partiallyPaid: !s.paid && (s.paidAmount || 0) > 0,
    };
  });

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const unpaidSplits = splits.filter((s) => !s.paid);

  // Only urgent if unpaid splits exist AND all of them are in the past
  const isUrgent = unpaidSplits.length > 0 &&
    unpaidSplits.every((s) => s.rawDate < today);

  const remainingBalance = unpaidSplits.reduce((sum, s) => sum + s.amount, 0);

  return {
    nickname: card.nickname,
    type: "credit",
    urgent: isUrgent,
    fullAmountDue: round(remainingBalance),
    statementBalance: card.statementBalance || card.currentBalance,
    dueDate: calculateNextDueDate(card),
    splits,
    lockedSplits: true,
  };
}

// ─────────────────────────────────────────
// PENDING CARD SPLITS
// No due date yet — split across next 4 pay periods
// ─────────────────────────────────────────

function calculatePendingCardSplits(card, globalSettings = {}) {
  const balance = parseFloat(card.statementBalance || card.currentBalance || 0);
  const nickname = card.nickname;

  const frequency =
    card.paymentFrequency ||
    globalSettings.paymentFrequency ||
    "weekly";

  const paydayName =
    card.paydayName ||
    globalSettings.paydayName ||
    "thursday";

  const paydayOfMonth =
    card.paydayOfMonth ||
    globalSettings.paydayOfMonth ||
    1;

  // Get next 4 pay periods from today
  let upcomingPaydays = [];

  if (frequency === "monthly") {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = 0; i < 4; i++) {
      const d = new Date(today.getFullYear(), today.getMonth() + i, paydayOfMonth);
      if (d >= today) upcomingPaydays.push(d);
      if (upcomingPaydays.length >= 4) break;
    }
  } else {
    const step = frequency === "biweekly" ? 14 : 7;
    const targetDay = DAY_NAME_TO_INDEX[paydayName.toLowerCase()] ?? 4;
    const cursor = new Date();
    cursor.setHours(0, 0, 0, 0);
    // If today is payday (daysUntil === 0), include today
    const daysUntil = (targetDay - cursor.getDay() + 7) % 7;
    cursor.setDate(cursor.getDate() + daysUntil);
    for (let i = 0; i < 4; i++) {
      upcomingPaydays.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + step);
    }
  }

  // Remove skipped pay periods
  // Use local date string to avoid timezone issues (matching locked split format)
  const skippedDates = (globalSettings.skippedPayPeriods || []).map((s) => s.date);
  upcomingPaydays = upcomingPaydays.filter((d) => {
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    return !skippedDates.includes(key);
  });

  if (upcomingPaydays.length === 0) {
    return {
      nickname, type: "credit", urgent: true,
      message: "Please verify your due date to continue tracking this card.",
      fullAmountDue: round(balance), dueDate: null, splits: [],
    };
  }

  // Build splits with properly formatted dates matching locked split format
  const amountPerPayday = round(balance / upcomingPaydays.length);
  const pendingSplits = upcomingPaydays.map((date, index) => {
    const isLast = index === upcomingPaydays.length - 1;
    const amount = isLast
      ? round(balance - amountPerPayday * (upcomingPaydays.length - 1))
      : amountPerPayday;
    return {
      date: date.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      rawDate: date,
      amount,
      paid: false,
      paidAmount: 0,
      partiallyPaid: false,
    };
  });

  return {
    nickname,
    type: "credit",
    urgent: false,
    pendingFirstStatement: true,
    statementBalance: round(balance),
    dueDate: null,
    frequency,
    paydayCount: upcomingPaydays.length,
    amountPerPayday: pendingSplits[0]?.amount,
    splits: pendingSplits,
  };
}

// ─────────────────────────────────────────
// BILLS
// ─────────────────────────────────────────

const BILL_STATUS = {
  UNPAID: "unpaid", PARTIAL: "partial",
  PAID: "paid", OVERDUE: "overdue",
};

function checkOverdueBills(bills) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return bills.map((bill) => {
    if (bill.status === BILL_STATUS.PAID) return bill;
    const due = new Date(bill.billDueDate);
    due.setHours(0, 0, 0, 0);
    if (due < today) return { ...bill, status: BILL_STATUS.OVERDUE };
    return bill;
  });
}

function getAllBillSplits(bills, globalSettings = {}) {
  return bills
    .filter((b) => b.status !== BILL_STATUS.PAID)
    .filter((b) => (b.amount || 0) > 0)
    .map((bill) => calculateBillSplits({
      nickname: bill.billNickname,
      amount: bill.amount,
      dueDate: bill.billDueDate,
      // Per-bill overrides (optional)
      paymentFrequency: bill.paymentFrequency,
      paydayName: bill.paydayName,
      paydayOfMonth: bill.paydayOfMonth,
    }, globalSettings));
}

// ─────────────────────────────────────────
// ICLOUD STORAGE
// ─────────────────────────────────────────

const FILE_MANAGER = FileManager.iCloud();
const BASE_PATH = FILE_MANAGER.documentsDirectory();
const CARDS_PATH = `${BASE_PATH}/uninterested_cards.json`;
const BILLS_PATH = `${BASE_PATH}/uninterested_bills.json`;
const SETTINGS_PATH = `${BASE_PATH}/uninterested_settings.json`;

function readJSON(path) {
  try {
    if (!FILE_MANAGER.fileExists(path)) return null;
    return JSON.parse(FILE_MANAGER.readString(path));
  } catch (e) { return null; }
}

function writeJSON(path, data) {
  FILE_MANAGER.writeString(path, JSON.stringify(data, null, 2));
}

// ─────────────────────────────────────────
// YNAB SYNC
// ─────────────────────────────────────────

const YNAB_API_BASE = "https://api.youneedabudget.com/v1";

async function syncYNABBalances(cards, token, budgetId) {
  try {
    const req = new Request(`${YNAB_API_BASE}/budgets/${budgetId}/accounts`);
    req.headers = { Authorization: `Bearer ${token}` };
    const data = await req.loadJSON();
    const accounts = data.data.accounts;

    return cards.map((card) => {
      const match = accounts.find((a) => a.id === card.ynabId);
      if (!match) return card;
      return { ...card, currentBalance: Math.abs(match.balance / 1000) };
    });
  } catch (e) {
    return cards; // return unmodified if offline
  }
}

// ─────────────────────────────────────────
// FIRST STATEMENT PROMPT
// ─────────────────────────────────────────

/**
 * Check if any pending-first-statement cards are ready
 * to have real dates entered. Fires 30 days after card creation.
 * Only prompts when widget is opened manually (not on refresh).
 */
async function checkFirstStatementPrompts(cards) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let updated = false;

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    if (!card.pendingFirstStatement) continue;

    const created = new Date(card.createdAt);
    created.setHours(0, 0, 0, 0);
    const daysSinceCreation = Math.round((today - created) / (24 * 60 * 60 * 1000));

    if (daysSinceCreation >= 30) {
      const alert = new Alert();
      alert.title = `${card.nickname} — First Statement`;
      alert.message =
        "Your new card has been active for about a month.
" +
        "Has your first statement closed yet?

" +
        "If so, open Setup to add your closing
" +
        "and due dates for accurate splits.";
      alert.addAction("Open Setup");
      alert.addAction("Not yet");
      const choice = await alert.present();
      // We just surface the prompt here —
      // actual date entry happens in setup
    }
  }

  return { cards, updated };
}

// ─────────────────────────────────────────
// RECURRING SKIP CHECK
// ─────────────────────────────────────────

/**
 * Check if any previously skipped pay period (with askAgain: true)
 * matches the upcoming pay period date. If so, prompt the user
 * to confirm whether to skip it again.
 */
async function checkRecurringSkipPrompt(settings) {
  if (!settings.skippedPayPeriods || settings.skippedPayPeriods.length === 0) {
    return settings;
  }

  const recurringSkips = settings.skippedPayPeriods.filter((s) => s.askAgain);
  if (recurringSkips.length === 0) return settings;

  const frequency = settings.paymentFrequency || "weekly";
  const step = frequency === "biweekly" ? 14 : frequency === "monthly" ? null : 7;

  // Find the next upcoming payday
  let nextPayday;
  if (frequency === "monthly") {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const paydayOfMonth = settings.paydayOfMonth || 1;
    nextPayday = new Date(today.getFullYear(), today.getMonth(), paydayOfMonth);
    if (nextPayday < today) {
      nextPayday = new Date(today.getFullYear(), today.getMonth() + 1, paydayOfMonth);
    }
  } else {
    const upcoming = getWeeklyPaydaysBefore(
      new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      settings.paydayName || "thursday"
    );
    nextPayday = upcoming[0];
  }

  if (!nextPayday) return settings;
  const nextPaydayKey = nextPayday.toISOString().split("T")[0];

  // Check if this date already has a skip entry for the upcoming date
  const alreadyHandled = settings.skippedPayPeriods.some((s) => s.date === nextPaydayKey);
  if (alreadyHandled) return settings;

  // Only prompt if we're within a few days of the upcoming payday
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysUntil = Math.round((nextPayday - today) / (24 * 60 * 60 * 1000));
  if (daysUntil > 3 || daysUntil < 0) return settings;

  // There IS a recurring-skip flag set previously — ask if this applies again
  const alert = new Alert();
  alert.title = "Heads Up";
  alert.message =
    `You previously skipped a pay period and asked to be\n` +
    `reminded. Your next pay period is ` +
    `${nextPayday.toLocaleDateString("en-US", { month: "long", day: "numeric" })}.\n\n` +
    "Will you be paid this time?";
  alert.addAction("Yes, I'll be paid");
  alert.addAction("No, skip this one too");
  const choice = await alert.present();

  if (choice === 1) {
    const updated = {
      ...settings,
      skippedPayPeriods: [
        ...settings.skippedPayPeriods,
        { date: nextPaydayKey, askAgain: true },
      ],
    };
    writeJSON(SETTINGS_PATH, updated);
    return updated;
  }

  return settings;
}

// ─────────────────────────────────────────
// MANUAL CARD BALANCE PROMPT
// ─────────────────────────────────────────

async function checkManualCardPrompts(cards) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let updated = false;

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    if (!card.isManual) continue; // skip YNAB cards

    // Calculate the most recent closing date
    const closingDate = new Date(
      today.getFullYear(),
      today.getMonth(),
      card.closingDay
    );
    if (closingDate > today) {
      closingDate.setMonth(closingDate.getMonth() - 1);
    }

    // Prompt 7 days after closing, once per cycle
    const promptDate = new Date(closingDate);
    promptDate.setDate(promptDate.getDate() + 7);

    const alreadyPrompted =
      card.balancePromptedAt &&
      new Date(card.balancePromptedAt) >= closingDate;

    if (today >= promptDate && !alreadyPrompted) {
      const alert = new Alert();
      alert.title = `Update Balance — ${card.nickname}`;
      alert.message =
        `Your ${card.nickname} statement closed on ` +
        `${closingDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })}.

` +
        `What is your statement balance?
` +
        `(Current: $${card.statementBalance.toFixed(2)})`;
      alert.addTextField("e.g. 450.00");
      alert.addAction("Update");
      alert.addCancelAction("Remind me later");

      const result = await alert.present();
      if (result === 0) {
        const newBalance = parseFloat(alert.textFieldValue(0).trim());
        if (!isNaN(newBalance) && newBalance >= 0) {
          cards[i] = {
            ...card,
            statementBalance: newBalance,
            currentBalance: newBalance,
            balancePromptedAt: today.toISOString().split("T")[0],
            verified: true,
            snoozedVerification: false,
          };
          updated = true;
        }
      }
    }
  }

  return { cards, updated };
}

// ─────────────────────────────────────────
// CYCLE CALCULATIONS
// ─────────────────────────────────────────

function calculateNextDueDate(card) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const currentMonth = today.getMonth();
  const currentYear = today.getFullYear();

  // Find the most recent closing date
  let closingDate = new Date(currentYear, currentMonth, card.closingDay);
  if (closingDate > today) {
    closingDate = new Date(currentYear, currentMonth - 1, card.closingDay);
  }

  // Due date is a fixed day of the month, always the month after closing
  const dueMonth = closingDate.getMonth() + 1;
  const dueYear = closingDate.getFullYear() + (dueMonth > 11 ? 1 : 0);
  const dueDate = new Date(dueYear, dueMonth % 12, card.dueDay);

  return dueDate.toISOString().split("T")[0];
}

// ─────────────────────────────────────────
// WIDGET COLORS
// ─────────────────────────────────────────

const COLORS = {
  background: new Color("#1a1a2e"),
  urgent:     new Color("#e94560"),
  text:       new Color("#ffffff"),
  subtext:    new Color("#a8a8b3"),
  credit:     new Color("#4cc9f0"),
  bill:       new Color("#7bed9f"),
  total:      new Color("#ffd60a"),
  divider:    new Color("#2d2d44"),
};

// ─────────────────────────────────────────
// WIDGET BUILDER
// ─────────────────────────────────────────

async function buildWidget(cards, bills, settings) {
  const widget = new ListWidget();
  widget.backgroundColor = COLORS.background;
  widget.setPadding(12, 12, 12, 12);

  // Header
  const header = widget.addText("💳 uninterested");
  header.textColor = COLORS.text;
  header.font = Font.boldSystemFont(14);
  widget.addSpacer(6);

  // Setup incomplete
  if (!settings || !settings.setupComplete) {
    const msg = widget.addText("Setup not complete. Open the app to finish setup.");
    msg.textColor = COLORS.urgent;
    msg.font = Font.systemFont(12);
    return widget;
  }

  // Global payment settings (cards/bills inherit unless overridden)
  const globalSettings = {
    paymentFrequency: settings.paymentFrequency || "weekly",
    paydayName: settings.paydayName || "thursday",
    paydayOfMonth: settings.paydayOfMonth || 1,
    skippedPayPeriods: settings.skippedPayPeriods || [],
  };

  // Sync YNAB balances (currentBalance only — never affects locked splits)
  let token;
  try { token = Keychain.get("uninterested_ynab_token"); } catch (e) { token = null; }
  let syncedCards = token
    ? await syncYNABBalances(cards, token, settings.budgetId)
    : [...cards];

  // Lock or refresh splits for each card as needed
  let cardsNeedSave = false;
  const processedCards = await Promise.all(syncedCards.map(async (card) => {
    if (!card.verified) return card;
    if ((card.statementBalance || card.currentBalance || 0) <= 0) return card;
    if (card.pendingFirstStatement) return card;

    // Regenerate locked splits if needed (new statement or first time)
    if (splitsNeedRefresh(card)) {
      const newSplits = calculateLockedSplits(card, globalSettings);
      cardsNeedSave = true;
      return {
        ...card,
        lockedSplits: newSplits,
        splitLockedAt: new Date().toISOString().split("T")[0],
      };
    }

    // Check YNAB payments and update paid status on splits
    if (token && card.ynabId) {
      const updatedSplits = await checkAndUpdateSplitPayments(
        card, card.lockedSplits, token, settings.budgetId, globalSettings
      );
      const changed = JSON.stringify(updatedSplits) !== JSON.stringify(card.lockedSplits);
      if (changed) {
        cardsNeedSave = true;
        return { ...card, lockedSplits: updatedSplits };
      }
    }

    return card;
  }));

  if (cardsNeedSave) {
    writeJSON(CARDS_PATH, processedCards);
  }

  // Card splits — built from lockedSplits, not live balance
  const cardSplits = processedCards
    .filter((c) => c.verified)
    .filter((c) => (c.statementBalance || 0) > 0)
    .map((card) => {
      if (card.pendingFirstStatement) {
        return calculatePendingCardSplits(card, globalSettings);
      }
      return buildCardSplitFromLocked(card);
    });

  // Bill splits
  const checkedBills = checkOverdueBills(bills || []);
  const billSplits = getAllBillSplits(checkedBills, globalSettings);

  // Weekly totals
  const weeklyTotals = calculateWeeklyTotals([...cardSplits, ...billSplits]);

  // Urgent items
  const allUrgent = [
    ...cardSplits.filter((c) => c.urgent),
    ...billSplits.filter((b) => b.urgent),
  ];

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
      const urgentAmt = item.fullAmountDue ?? item.statementBalance ?? 0;
      const amt = row.addText(`$${urgentAmt.toFixed(2)}`);
      amt.textColor = COLORS.urgent;
      amt.font = Font.boldSystemFont(11);
    }
    widget.addSpacer(6);
  }

  // Unverified card warnings
  const unverified = syncedCards.filter((c) => !c.verified || c.snoozedVerification);
  for (const card of unverified) {
    const msg = widget.addText(
      `${card.nickname}: Please verify your due date to continue tracking this card.`
    );
    msg.textColor = COLORS.urgent;
    msg.font = Font.italicSystemFont(10);
    widget.addSpacer(2);
  }

  // Weekly breakdown (max 3 paydays)
  const weeksToShow = Math.min(weeklyTotals.length, 3);

  for (let i = 0; i < weeksToShow; i++) {
    const week = weeklyTotals[i];

    // Week header
    const weekHeader = widget.addStack();
    weekHeader.layoutHorizontally();
    const weekTitle = weekHeader.addText(
      i === 0 ? `THIS ${settings.paydayName.toUpperCase()}` : week.date
    );
    weekTitle.textColor = COLORS.text;
    weekTitle.font = Font.boldSystemFont(11);
    weekHeader.addSpacer();
    const weekTotal = weekHeader.addText(`$${week.total.toFixed(2)}`);
    weekTotal.textColor = COLORS.total;
    weekTotal.font = Font.boldSystemFont(11);
    widget.addSpacer(2);

    // Credit card rows
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

      const subRow = widget.addStack();
      subRow.layoutHorizontally();
      const subLabel = subRow.addText("  Subtotal");
      subLabel.textColor = COLORS.subtext;
      subLabel.font = Font.italicSystemFont(9);
      subRow.addSpacer();
      const subAmt = subRow.addText(`$${week.cardSubtotal.toFixed(2)}`);
      subAmt.textColor = COLORS.credit;
      subAmt.font = Font.italicSystemFont(9);
    }

    // Bill rows
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

      const subRow = widget.addStack();
      subRow.layoutHorizontally();
      const subLabel = subRow.addText("  Subtotal");
      subLabel.textColor = COLORS.subtext;
      subLabel.font = Font.italicSystemFont(9);
      subRow.addSpacer();
      const subAmt = subRow.addText(`$${week.billSubtotal.toFixed(2)}`);
      subAmt.textColor = COLORS.bill;
      subAmt.font = Font.italicSystemFont(9);
    }

    // Divider between weeks
    if (i < weeksToShow - 1) {
      widget.addSpacer(4);
      const divider = widget.addText("─────────────────────");
      divider.textColor = COLORS.divider;
      divider.font = Font.systemFont(8);
      widget.addSpacer(4);
    }
  }

  // Last synced
  widget.addSpacer(6);
  const syncLabel = widget.addText(`Synced: ${settings.lastSyncDate || "never"}`);
  syncLabel.textColor = COLORS.subtext;
  syncLabel.font = Font.systemFont(8);

  return widget;
}

// ─────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────

async function run() {
  const cards = readJSON(CARDS_PATH) || [];
  const bills = readJSON(BILLS_PATH) || [];
  let settings = readJSON(SETTINGS_PATH);

  // Only check prompts when opened manually
  // (not during passive widget refresh, to avoid interrupting)
  if (!config.runsInWidget && settings) {
    settings = await checkRecurringSkipPrompt(settings);
    await checkFirstStatementPrompts(cards);
  }

  // Check if any manual cards need a balance update (7 days after closing)
  const promptResult = await checkManualCardPrompts(cards);
  if (promptResult.updated) {
    writeJSON(CARDS_PATH, promptResult.cards);
  }
  const finalCards = promptResult.cards;

  const widget = await buildWidget(finalCards, bills, settings);

  if (config.runsInWidget) {
    Script.setWidget(widget);
  } else {
    // Tapped from home screen or run manually
    // Re-read cards from disk to get updated locked splits
    const cardsForSummary = readJSON(CARDS_PATH) || finalCards;
    await showFullScreenSummary(cardsForSummary, bills, settings);
  }

  Script.complete();
}

async function showFullScreenSummary(cards, bills, settings) {
  if (!settings || !settings.setupComplete) {
    const alert = new Alert();
    alert.title = "uninterested";
    alert.message = "Setup not complete. Open the setup script to finish.";
    alert.addAction("OK");
    await alert.present();
    return;
  }

  // Sync balances
  let token = null;
  try { token = Keychain.get("uninterested_ynab_token"); } catch (e) {}
  const syncedCards = token
    ? await syncYNABBalances(cards, token, settings.budgetId)
    : cards;

  // Global payment settings (cards/bills inherit unless overridden)
  const globalSettings = {
    paymentFrequency: settings.paymentFrequency || "weekly",
    paydayName: settings.paydayName || "thursday",
    paydayOfMonth: settings.paydayOfMonth || 1,
  };

  // Card splits — use locked splits for accurate display
  const cardSplits = syncedCards
    .filter((c) => c.verified)
    .filter((c) => (c.statementBalance || 0) > 0)
    .map((card) => {
      if (card.pendingFirstStatement) {
        return calculatePendingCardSplits(card, globalSettings);
      }
      return buildCardSplitFromLocked(card);
    });

  const checkedBills = checkOverdueBills(bills || []);
  const billSplits = getAllBillSplits(checkedBills, globalSettings);
  const weeklyTotals = calculateWeeklyTotals([...cardSplits, ...billSplits]);

  const allUrgent = [
    ...cardSplits.filter((c) => c.urgent),
    ...billSplits.filter((b) => b.urgent),
  ];

  const unverified = syncedCards.filter((c) => !c.verified || c.snoozedVerification);

  // ── Build HTML ──
  let urgentHTML = "";
  if (allUrgent.length > 0) {
    urgentHTML += `<div class="section urgent-section">
      <div class="section-title urgent-title">🚨 URGENT — PAY NOW</div>`;
    for (const item of allUrgent) {
      const urgentAmt = item.fullAmountDue ?? item.statementBalance ?? 0;
      urgentHTML += `<div class="row">
        <span class="label urgent-text">${item.nickname}</span>
        <span class="amount urgent-text">$${urgentAmt.toFixed(2)}</span>
      </div>`;
    }
    urgentHTML += `</div>`;
  }

  let verifyHTML = "";
  if (unverified.length > 0) {
    verifyHTML += `<div class="section verify-section">
      <div class="section-title verify-title">⚠️ NEEDS VERIFICATION</div>`;
    for (const card of unverified) {
      verifyHTML += `<div class="row">
        <span class="label verify-text">${card.nickname}</span>
      </div>`;
    }
    verifyHTML += `</div>`;
  }

  let weeksHTML = "";
  for (let i = 0; i < weeklyTotals.length; i++) {
    const week = weeklyTotals[i];
    const label = i === 0
      ? `THIS ${settings.paydayName.toUpperCase()}`
      : week.date;

    weeksHTML += `<div class="section week-section">
      <div class="week-header">
        <span class="week-label">${label}</span>
        <span class="week-total">$${week.total.toFixed(2)}</span>
      </div>`;

    if (week.cards.length > 0) {
      weeksHTML += `<div class="type-label credit-label">💳 CARDS</div>`;
      for (const card of week.cards) {
        const cardSplit = cardSplits.find((s) => s.nickname === card.nickname);
        const isPending = cardSplit && cardSplit.pendingFirstStatement;

        // Find the locked split for this specific pay period date
        const lockedSplit = cardSplit && cardSplit.lockedSplits
          ? cardSplit.splits.find((s) => s.date === week.rawDate?.toISOString().split("T")[0])
          : null;

        const isPaid = lockedSplit && lockedSplit.paid;
        const isPartial = lockedSplit && lockedSplit.partiallyPaid;
        const remaining = lockedSplit
          ? round(lockedSplit.amount - (lockedSplit.paidAmount || 0))
          : card.amount;

        weeksHTML += `<div class="row">
          <span class="label ${isPaid ? "paid-label" : "subtext"}">
            ${isPaid ? "✅ " : ""}${card.nickname}${isPending ? " 🆕" : ""}
          </span>
          <span class="amount ${isPaid ? "paid-amount" : "credit-amount"}">
            ${isPaid
              ? `<span style="text-decoration:line-through;opacity:0.5">$${lockedSplit.originalAmount.toFixed(2)}</span>`
              : isPartial
                ? `$${remaining.toFixed(2)} <span class="partial">(paid $${lockedSplit.paidAmount.toFixed(2)})</span>`
                : `$${card.amount.toFixed(2)}${isPending ? " est." : ""}`
            }
          </span>
        </div>`;
      }
      weeksHTML += `<div class="row subtotal-row">
        <span class="label subtext">Subtotal</span>
        <span class="amount credit-amount">$${week.cardSubtotal.toFixed(2)}</span>
      </div>`;
    }

    if (week.bills.length > 0) {
      weeksHTML += `<div class="type-label bill-label">🧾 BILLS</div>`;
      for (const bill of week.bills) {
        weeksHTML += `<div class="row">
          <span class="label subtext">${bill.nickname}</span>
          <span class="amount bill-amount">$${bill.amount.toFixed(2)}</span>
        </div>`;
      }
      weeksHTML += `<div class="row subtotal-row">
        <span class="label subtext">Subtotal</span>
        <span class="amount bill-amount">$${week.billSubtotal.toFixed(2)}</span>
      </div>`;
    }

    weeksHTML += `</div>`;
  }

  if (weeksHTML === "" && urgentHTML === "") {
    weeksHTML = `<div class="section">
      <div class="label subtext">No upcoming payments found.</div>
    </div>`;
  }

  const html = `
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #1a1a2e;
    color: #ffffff;
    font-family: -apple-system, sans-serif;
    padding: 20px 16px 40px;
  }
  .header {
    font-size: 20px;
    font-weight: bold;
    margin-bottom: 20px;
    padding-bottom: 12px;
    border-bottom: 1px solid #2d2d44;
  }
  .section {
    margin-bottom: 20px;
    background: #16213e;
    border-radius: 12px;
    padding: 12px;
  }
  .week-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }
  .week-label {
    font-size: 14px;
    font-weight: bold;
    color: #ffffff;
  }
  .week-total {
    font-size: 14px;
    font-weight: bold;
    color: #ffd60a;
  }
  .type-label {
    font-size: 11px;
    font-weight: bold;
    margin: 8px 0 4px;
  }
  .credit-label { color: #4cc9f0; }
  .bill-label { color: #7bed9f; }
  .row {
    display: flex;
    justify-content: space-between;
    padding: 3px 0;
  }
  .subtotal-row {
    border-top: 1px solid #2d2d44;
    margin-top: 4px;
    padding-top: 4px;
  }
  .label { font-size: 13px; }
  .amount { font-size: 13px; }
  .subtext { color: #a8a8b3; }
  .credit-amount { color: #4cc9f0; }
  .bill-amount { color: #7bed9f; }
  .section-title {
    font-size: 13px;
    font-weight: bold;
    margin-bottom: 6px;
  }
  .urgent-section { background: #2d1a1e; }
  .urgent-title { color: #e94560; }
  .urgent-text { color: #e94560; }
  .verify-section { background: #1e1a2d; }
  .verify-title { color: #ffd60a; }
  .verify-text { color: #ffd60a; }
  .sync-label {
    font-size: 11px;
    color: #a8a8b3;
    text-align: center;
    margin-top: 12px;
  }
  .paid-label {
    color: #a8a8b3;
    font-size: 13px;
  }
  .paid-amount {
    color: #a8a8b3;
    font-size: 13px;
  }
  .partial {
    font-size: 11px;
    color: #a8a8b3;
  }
</style>
</head>
<body>
  <div class="header">💳 uninterested</div>
  ${urgentHTML}
  ${verifyHTML}
  ${weeksHTML}
  <div class="sync-label">Synced: ${settings.lastSyncDate || "never"}</div>
</body>
</html>`;

  const webView = new WebView();
  await webView.loadHTML(html);
  await webView.present(false); // false = full screen, not modal
}

await run();