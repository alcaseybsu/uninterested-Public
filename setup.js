/**
 * setup_scriptable.js
 * uninterested — One-time setup script (Scriptable version)
 *
 * This is the combined single-file version for use in Scriptable.
 * All functions from sanitizer.js, calculator.js, bills.js,
 * and setup.js are included here — no require() calls needed.
 *
 * Run this once to configure your cards, bills, and payday.
 * After setup, add widget_scriptable.js as your home screen widget.
 *
 * In Scriptable, name this script: setup
 */

// ─────────────────────────────────────────
// SANITIZER
// From sanitizer.js — runs on all data before storing
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

const ALLOWED_FIELDS = [
  "statementBalance", "currentBalance", "minimumPayment",
  "closingDate", "dueDate", "nickname", "lastFour",
  "cycleLength", "amount", "billNickname", "billDueDate",
  "splitFrequency", "isFlexible", "notes",
];

function scrubString(value) {
  if (typeof value !== "string") return value;
  let scrubbed = value;
  for (const pattern of PII_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, "[removed]");
  }
  return scrubbed;
}

function validateNickname(nickname) {
  if (typeof nickname !== "string") {
    return { valid: false, reason: "Nickname must be text." };
  }
  if (nickname.length > 30) {
    return { valid: false, reason: "Nickname is too long (max 30 characters)." };
  }
  if (/\d{5,}/.test(nickname)) {
    return { valid: false, reason: "Nicknames can only contain up to 4 digits (e.g. last four of card)." };
  }
  const scrubbed = scrubString(nickname);
  if (scrubbed.includes("[removed]")) {
    return { valid: false, reason: "Nickname appears to contain personal information. Please use a simple label like 'Travel Card' or last 4 digits only." };
  }
  return { valid: true };
}

function sanitizeObject(obj) {
  const clean = {};
  for (const key of ALLOWED_FIELDS) {
    if (obj.hasOwnProperty(key)) {
      const value = obj[key];
      clean[key] = typeof value === "string" ? scrubString(value) : value;
    }
  }
  return clean;
}

// ─────────────────────────────────────────
// CALCULATOR
// From calculator.js — payday split engine
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

function getPaydaysBefore(dueDate, paydayName = "thursday") {
  const paydays = [];
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);

  const targetDay = DAY_NAME_TO_INDEX[paydayName.toLowerCase()];
  if (targetDay === undefined) throw new Error(`Invalid payday: "${paydayName}"`);

  const cursor = new Date(getToday());
  const daysUntilPayday = (targetDay - cursor.getDay() + 7) % 7 || 7;
  cursor.setDate(cursor.getDate() + daysUntilPayday);

  while (cursor <= due) {
    paydays.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 7);
  }
  return paydays;
}

function getBiweeklyPaydaysBefore(dueDate, paydayName = "thursday") {
  return getPaydaysBefore(dueDate, paydayName).filter((_, i) => i % 2 === 0);
}

function formatDate(date) {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function round(amount) {
  return Math.round(amount * 100) / 100;
}

// ─────────────────────────────────────────
// BILLS
// From bills.js — bill creation and tracking
// ─────────────────────────────────────────

const BILL_STATUS = {
  UNPAID: "unpaid", PARTIAL: "partial",
  PAID: "paid", OVERDUE: "overdue",
};

const SPLIT_FREQUENCY = { WEEKLY: "weekly", BIWEEKLY: "biweekly" };

function createBill(billInput) {
  const nicknameCheck = validateNickname(billInput.nickname);
  if (!nicknameCheck.valid) return { success: false, error: nicknameCheck.reason };

  const amount = parseFloat(billInput.amount);
  if (isNaN(amount) || amount <= 0) return { success: false, error: "Amount must be a positive number." };

  const due = new Date(billInput.dueDate);
  if (isNaN(due.getTime())) return { success: false, error: "Please enter a valid due date." };

  const freq = billInput.splitFrequency?.toLowerCase();
  if (!Object.values(SPLIT_FREQUENCY).includes(freq)) return { success: false, error: 'Split frequency must be "weekly" or "biweekly".' };

  const notes = billInput.notes ? scrubString(billInput.notes).substring(0, 200) : "";

  const bill = sanitizeObject({
    billNickname: billInput.nickname.trim(),
    amount, billDueDate: billInput.dueDate,
    splitFrequency: freq, isFlexible: true, notes,
  });

  bill.id = "bill_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7);
  bill.status = BILL_STATUS.UNPAID;
  bill.originalAmount = amount;
  bill.createdAt = new Date().toISOString().split("T")[0];
  bill.paidAmount = 0;
  bill.lastUpdated = bill.createdAt;

  return { success: true, bill };
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
// YNAB
// ─────────────────────────────────────────

const YNAB_API_BASE = "https://api.youneedabudget.com/v1";

async function fetchYNABAccounts(token) {
  try {
    // Step 1: fetch all budgets and use the most recently modified one
    const budgetReq = new Request(`${YNAB_API_BASE}/budgets`);
    budgetReq.headers = { Authorization: `Bearer ${token}` };
    const budgetData = await budgetReq.loadJSON();
    const budgets = budgetData.data.budgets;

    if (!budgets || budgets.length === 0) {
      return { success: false, error: "No budgets found in your YNAB account." };
    }

    // Sort by last_modified_on descending, use the most recent
    budgets.sort((a, b) => new Date(b.last_modified_on) - new Date(a.last_modified_on));
    const budgetId = budgets[0].id;

    // Step 2: fetch accounts for that budget
    const accountReq = new Request(`${YNAB_API_BASE}/budgets/${budgetId}/accounts`);
    accountReq.headers = { Authorization: `Bearer ${token}` };
    const accountData = await accountReq.loadJSON();

    const creditCards = accountData.data.accounts.filter(
      (a) => a.type === "creditCard" && !a.closed && !a.deleted
    );

    return {
      success: true,
      budgetId,
      accounts: creditCards.map((a) => ({
        ynabId: a.id,
        ynabName: a.name,
        balance: Math.abs(a.balance / 1000),
        clearedBalance: Math.abs(a.cleared_balance / 1000), // posted transactions only
      })),
    };
  } catch (e) {
    return { success: false, error: `Could not connect to YNAB: ${e.message}` };
  }
}

// ─────────────────────────────────────────
// SETUP HELPERS
// ─────────────────────────────────────────

function generateCardId() {
  return "card_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7);
}

function configureCard(input) {
  const nicknameCheck = validateNickname(input.nickname);
  if (!nicknameCheck.valid) return { success: false, error: nicknameCheck.reason };

  // pendingFirstStatement cards skip closing/due day validation
  const isPending = input.pendingFirstStatement || false;

  const closingDay = isPending ? null : parseInt(input.closingDay);
  if (!isPending && (isNaN(closingDay) || closingDay < 1 || closingDay > 31)) {
    return { success: false, error: "Closing day must be between 1 and 31." };
  }

  const dueDay = isPending ? null : parseInt(input.dueDay);
  if (!isPending && (isNaN(dueDay) || dueDay < 1 || dueDay > 31)) {
    return { success: false, error: "Due date day must be between 1 and 31." };
  }

  // ynabId is null for manually entered cards
  const isManual = !input.ynabId;

  return {
    success: true,
    card: {
      id: generateCardId(),
      ynabId: input.ynabId || null,
      isManual,
      nickname: input.nickname.trim(),
      closingDay,
      dueDay,
      // statementBalance = cleared transactions (what you owe from last statement)
      // This is the amount we split across pay periods — never updated from currentBalance
      statementBalance: input.statementBalance || input.clearedBalance || 0,
      currentBalance: input.balance || input.clearedBalance || 0,
      lastClosingDate: null, nextDueDate: null,
      verified: false, snoozedVerification: false,
      balancePromptedAt: null,
      pendingFirstStatement: input.pendingFirstStatement || false,
      createdAt: new Date().toISOString().split("T")[0],
    },
  };
}

// ─────────────────────────────────────────
// SETUP FLOW
// Uses Scriptable's native Alert UI
// ─────────────────────────────────────────

async function showPrivacyOnboarding() {
  const alert = new Alert();
  alert.title = "🔒 Your Privacy, By Design";
  alert.message =
    "We never see or store:\n" +
    "✗ Your name or address\n" +
    "✗ Full card numbers\n" +
    "✗ Your YNAB login credentials\n" +
    "✗ Any uploaded images or PDFs\n\n" +
    "Your data lives on YOUR device.\n" +
    "Cards are identified only by nicknames you choose.\n" +
    "You can delete everything in Settings at any time.";
  alert.addAction("Got it");
  await alert.present();
}

async function askPaymentPreference() {
  // Step 1: frequency
  const freqAlert = new Alert();
  freqAlert.title = "Payment Frequency";
  freqAlert.message =
    "How often do you want to make payments?\n" +
    "This will be your default for all cards and bills.\n" +
    "You can override it per card or bill.";
  freqAlert.addAction("Weekly");
  freqAlert.addAction("Biweekly (every other week)");
  freqAlert.addAction("Monthly");
  const freqIndex = await freqAlert.present();
  const frequency = ["weekly", "biweekly", "monthly"][freqIndex];

  if (frequency === "monthly") {
    // Ask for day of month
    const dayAlert = new Alert();
    dayAlert.title = "Monthly Payment Day";
    dayAlert.message =
      "What day of the month do you want to make payments?\n" +
      "Enter a number between 1 and 31.";
    dayAlert.addTextField("e.g. 1");
    dayAlert.addAction("Save");
    await dayAlert.present();
    const paydayOfMonth = parseInt(dayAlert.textFieldValue(0).trim()) || 1;
    return { paymentFrequency: "monthly", paydayOfMonth };
  }

  // Weekly or biweekly — ask for day of week
  const dayAlert = new Alert();
  dayAlert.title = frequency === "biweekly"
    ? "Biweekly Payment Day"
    : "Weekly Payment Day";
  dayAlert.message = "What day of the week do you want to make payments?";
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  for (const day of days) dayAlert.addAction(day);
  const dayIndex = await dayAlert.present();
  const paydayName = days[dayIndex].toLowerCase();

  return { paymentFrequency: frequency, paydayName };
}

// Ask for per-card/bill payment override (optional)
async function askPaymentOverride(nickname, globalPrefs) {
  const currentDesc = globalPrefs.paymentFrequency === "monthly"
    ? `monthly on the ${globalPrefs.paydayOfMonth}`
    : `${globalPrefs.paymentFrequency} on ${globalPrefs.paydayName}`;

  const alert = new Alert();
  alert.title = `Payment Schedule — ${nickname}`;
  alert.message =
    `Your default is: ${currentDesc}\n\n` +
    "Use the same schedule for this card/bill,\n" +
    "or set a different one?";
  alert.addAction("Use default");
  alert.addAction("Set a different schedule");
  const choice = await alert.present();

  if (choice === 0) return null; // use global
  return await askPaymentPreference();
}

async function askYNABToken() {
  const alert = new Alert();
  alert.title = "Enter Your YNAB Token";
  alert.message =
    "Go to app.youneedabudget.com/settings/developer\n" +
    "and create a Personal Access Token.\n\n" +
    "This is stored in your iOS Keychain only.\n" +
    "We never see it.";
  alert.addTextField("Paste token here");
  alert.addAction("Connect");
  alert.addCancelAction("Cancel");
  const result = await alert.present();
  if (result === -1) return null;
  return alert.textFieldValue(0).trim();
}

async function configureCardInteractive(account) {
  // Ask for nickname
  const nicknameAlert = new Alert();
  nicknameAlert.title = `Set Up: ${account.ynabName}`;
  nicknameAlert.message =
    "Choose a nickname for this card.\n" +
    "Use something only you would recognize —\n" +
    "e.g. 'Travel Card', 'Gas Card', or last 4 digits.\n\n" +
    "The card's real name will not be stored.";
  nicknameAlert.addTextField("Nickname");
  nicknameAlert.addAction("Next");
  nicknameAlert.addCancelAction("Skip this card");
  const nicknameResult = await nicknameAlert.present();
  if (nicknameResult === -1) return null;

  const nickname = nicknameAlert.textFieldValue(0).trim();
  const nicknameCheck = validateNickname(nickname);
  if (!nicknameCheck.valid) {
    const errAlert = new Alert();
    errAlert.title = "Invalid Nickname";
    errAlert.message = nicknameCheck.reason;
    errAlert.addAction("Try Again");
    await errAlert.present();
    return configureCardInteractive(account); // retry
  }

  // Ask if first statement has closed yet
  const firstStatementAlert = new Alert();
  firstStatementAlert.title = `${nickname} — First Statement`;
  firstStatementAlert.message =
    "Has this card had its first statement close yet?\n\n" +
    "New cards sometimes take a full billing cycle\n" +
    "before the first due date appears.";
  firstStatementAlert.addAction("Yes, I have a statement");
  firstStatementAlert.addAction("Not yet — but I want to start tracking");
  const firstStatementChoice = await firstStatementAlert.present();
  const pendingFirstStatement = firstStatementChoice === 1;

  let closingDay = null;
  let dueDay = null;

  if (pendingFirstStatement) {
    // No due date yet — skip closing/due day entirely
    // Widget will split balance across next 4 pay periods instead
    const infoAlert = new Alert();
    infoAlert.title = `${nickname} — No Statement Yet`;
    infoAlert.message =
      "No problem! Until your first statement closes,\n" +
      "uninterested will split your current balance\n" +
      "evenly across your next 4 pay periods.\n\n" +
      "When your first statement arrives, open setup\n" +
      "and update this card with your real closing\n" +
      "and due dates.";
    infoAlert.addAction("Got it");
    await infoAlert.present();
  } else {
    // Normal flow — ask for closing day and due day
    const closingAlert = new Alert();
    closingAlert.title = `${nickname} — Closing Day`;
    closingAlert.message =
      "What day of the month does your statement close?\n" +
      "Check a recent statement if unsure.\n" +
      "Enter a number between 1 and 31.";
    closingAlert.addTextField("e.g. 28");
    closingAlert.addAction("Next");
    await closingAlert.present();
    closingDay = closingAlert.textFieldValue(0).trim();

    const dueAlert = new Alert();
    dueAlert.title = `${nickname} — Due Date`;
    dueAlert.message =
      "What day of the month is your payment due?\n" +
      "Check your most recent statement.\n" +
      "Enter a number between 1 and 31.";
    dueAlert.addTextField("e.g. 7");
    dueAlert.addAction("Save Card");
    await dueAlert.present();
    dueDay = dueAlert.textFieldValue(0).trim();
  }

  // Confirm or correct statement balance before configuring card
  // cleared_balance from YNAB is a good starting point but may not match
  // the exact statement balance if new purchases have posted since closing
  let confirmedBalance = account.clearedBalance || account.balance || 0;
  if (!pendingFirstStatement) {
    const balanceAlert = new Alert();
    balanceAlert.title = `${nickname} — Statement Balance`;
    balanceAlert.message =
      `YNAB shows a cleared balance of $${(account.clearedBalance || 0).toFixed(2)}\n\n` +
      "This is used to calculate your payment splits.\n" +
      "Does this match your last statement balance?\n\n" +
      "If not, enter the correct amount below.";
    balanceAlert.addTextField("Statement balance", (account.clearedBalance || 0).toFixed(2));
    balanceAlert.addAction("Use this amount");
    await balanceAlert.present();
    confirmedBalance = parseFloat(balanceAlert.textFieldValue(0)) || account.clearedBalance || 0;
  }

  const result = configureCard({
    ynabId: account.ynabId,
    nickname, closingDay, dueDay,
    pendingFirstStatement,
    balance: account.balance,
    clearedBalance: confirmedBalance,
  });

  if (!result.success) {
    const errAlert = new Alert();
    errAlert.title = "Something looks off";
    errAlert.message = result.error;
    errAlert.addAction("Try Again");
    await errAlert.present();
    return configureCardInteractive(account); // retry
  }

  // Ask for payment schedule override
  const existingSettings = readJSON(SETTINGS_PATH) || {};
  const globalPrefs = {
    paymentFrequency: existingSettings.paymentFrequency || "weekly",
    paydayName: existingSettings.paydayName || "thursday",
    paydayOfMonth: existingSettings.paydayOfMonth || 1,
  };
  const cardPaymentOverride = await askPaymentOverride(nickname, globalPrefs);

  // Confirmation screen — show what was entered before saving
  const freqDesc = cardPaymentOverride
    ? (cardPaymentOverride.paymentFrequency === "monthly"
        ? `monthly on the ${cardPaymentOverride.paydayOfMonth}`
        : `${cardPaymentOverride.paymentFrequency} on ${cardPaymentOverride.paydayName}`)
    : "using your default schedule";

  const confirmAlert = new Alert();
  confirmAlert.title = "Confirm Card Details";
  confirmAlert.message = pendingFirstStatement
    ? `Nickname:   ${nickname}\n` +
      `Status:     Pending first statement\n` +
      `Payments:   ${freqDesc}\n` +
      `Splits:     Balance across next 4 pay periods\n\n` +
      "Does this look correct?"
    : `Nickname:      ${nickname}\n` +
      `Closing day:   ${closingDay}th of each month\n` +
      `Due date:      ${dueDay}th of each month\n` +
      `Payments:      ${freqDesc}\n\n` +
      "Does this look correct?";
  confirmAlert.addAction("Looks good");
  confirmAlert.addDestructiveAction("Start this card over");
  const confirm = await confirmAlert.present();

  if (confirm === 1) {
    return configureCardInteractive(account);
  }

  // User confirmed — mark as verified, apply payment override if set
  const verifiedCard = {
    ...result.card,
    verified: true,
    lastVerifiedAt: new Date().toISOString().split("T")[0],
    ...(cardPaymentOverride || {}),
  };

  return verifiedCard;
}

// ─────────────────────────────────────────
// SKIP A PAY PERIOD
// ─────────────────────────────────────────

/**
 * Get a window of pay period dates: 2 past, today, and 4 upcoming.
 * Used so the user can pick a date to skip, including recent past ones.
 */
function getPayPeriodWindow(globalSettings) {
  const frequency = globalSettings.paymentFrequency || "weekly";
  const dates = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (frequency === "monthly") {
    const paydayOfMonth = globalSettings.paydayOfMonth || 1;
    // 2 past months, then next 4 months
    for (let i = -2; i <= 4; i++) {
      const d = new Date(today.getFullYear(), today.getMonth() + i, paydayOfMonth);
      dates.push(d);
    }
  } else {
    const targetDay = DAY_NAME_TO_INDEX[(globalSettings.paydayName || "thursday").toLowerCase()];
    const step = frequency === "biweekly" ? 14 : 7;

    // Find the most recent occurrence of targetDay on/before today
    const cursor = new Date(today);
    const diff = (cursor.getDay() - targetDay + 7) % 7;
    cursor.setDate(cursor.getDate() - diff);

    // Walk back 2 periods, then forward 6 total
    cursor.setDate(cursor.getDate() - step * 2);
    for (let i = 0; i < 7; i++) {
      dates.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + step);
    }
  }

  return dates.sort((a, b) => a - b);
}

/**
 * Interactive flow to mark a pay period as skipped.
 * Shows a window of dates (recent past + upcoming) to choose from.
 */
async function updateStatementBalancesInteractive() {
  const cards = readJSON(CARDS_PATH) || [];
  const settings = readJSON(SETTINGS_PATH) || {};

  if (cards.length === 0) {
    const alert = new Alert();
    alert.title = "No Cards Found";
    alert.message = "Run setup first to add your cards.";
    alert.addAction("OK");
    await alert.present();
    return;
  }

  // Optionally sync from YNAB first
  let token = null;
  try { token = Keychain.get("uninterested_ynab_token"); } catch (e) {}

  let ynabAccounts = [];
  if (token && settings.budgetId) {
    try {
      const req = new Request(`https://api.youneedabudget.com/v1/budgets/${settings.budgetId}/accounts`);
      req.headers = { Authorization: `Bearer ${token}` };
      const data = await req.loadJSON();
      ynabAccounts = data.data.accounts || [];
    } catch (e) {}
  }

  let updatedCards = [...cards];
  let anyUpdated = false;

  for (let i = 0; i < updatedCards.length; i++) {
    const card = updatedCards[i];
    if (card.pendingFirstStatement) continue;

    // Try to prefill from YNAB cleared_balance
    const ynabMatch = ynabAccounts.find((a) => a.id === card.ynabId);
    const prefill = ynabMatch
      ? (Math.abs(ynabMatch.cleared_balance) / 1000).toFixed(2)
      : (card.statementBalance || "").toString();

    const alert = new Alert();
    alert.title = `${card.nickname} — Statement Balance`;
    alert.message =
      `Current statement balance: $${(card.statementBalance || 0).toFixed(2)}\n` +
      (ynabMatch ? `YNAB cleared balance: $${prefill}\n` : "") +
      "\nEnter the statement balance from your last statement.\n" +
      "This is what you need to pay in full to avoid interest.";
    alert.addTextField("Statement balance", prefill);
    alert.addAction("Update");
    alert.addAction("Skip this card");
    const choice = await alert.present();

    if (choice === 0) {
      const newBalance = parseFloat(alert.textFieldValue(0));
      if (!isNaN(newBalance) && newBalance >= 0) {
        updatedCards[i] = {
          ...card,
          statementBalance: newBalance,
          // Clear locked splits so they regenerate from new balance
          lockedSplits: [],
          splitLockedAt: null,
        };
        anyUpdated = true;
      }
    }
  }

  if (anyUpdated) {
    writeJSON(CARDS_PATH, updatedCards);
    const doneAlert = new Alert();
    doneAlert.title = "Balances Updated ✓";
    doneAlert.message =
      "Statement balances saved.\n\n" +
      "Open the widget to see your updated payment splits.";
    doneAlert.addAction("Done");
    await doneAlert.present();
  } else {
    const doneAlert = new Alert();
    doneAlert.title = "No Changes Made";
    doneAlert.message = "No balances were updated.";
    doneAlert.addAction("OK");
    await doneAlert.present();
  }
}

async function skipPayPeriodInteractive() {
  const settings = readJSON(SETTINGS_PATH);
  if (!settings) return;

  const globalSettings = {
    paymentFrequency: settings.paymentFrequency || "weekly",
    paydayName: settings.paydayName || "thursday",
    paydayOfMonth: settings.paydayOfMonth || 1,
  };

  const window = getPayPeriodWindow(globalSettings);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const alert = new Alert();
  alert.title = "Skip a Pay Period";
  alert.message = "Select the date you will NOT be paid.\nPast and upcoming dates are shown.";

  for (const date of window) {
    const dateStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const label = date < today ? `${dateStr} (past)` : dateStr;
    alert.addAction(label);
  }
  alert.addCancelAction("Cancel");

  const index = await alert.present();
  if (index === -1) return;

  const selectedDate = window[index];
  const dateKey = selectedDate.toISOString().split("T")[0];

  // Confirm
  const confirmAlert = new Alert();
  confirmAlert.title = "Confirm Skip";
  confirmAlert.message =
    `Skip ${selectedDate.toLocaleDateString("en-US", { month: "long", day: "numeric" })}?\n\n` +
    "Payments scheduled for this date will be\n" +
    "redistributed across your other pay periods.";
  confirmAlert.addAction("Skip This Pay Period");
  confirmAlert.addCancelAction("Cancel");
  const confirmChoice = await confirmAlert.present();
  if (confirmChoice === -1) return;

  // Ask if they want to be prompted again next cycle
  const askAgainAlert = new Alert();
  askAgainAlert.title = "One More Thing";
  askAgainAlert.message =
    "Should uninterested ask you again before\n" +
    "the next matching pay period, in case this\n" +
    "happens regularly?";
  askAgainAlert.addAction("Yes, ask me again");
  askAgainAlert.addAction("No, this was a one-time thing");
  const askAgainChoice = await askAgainAlert.present();
  const askAgain = askAgainChoice === 0;

  const skippedList = settings.skippedPayPeriods || [];
  skippedList.push({ date: dateKey, askAgain });

  const updatedSettings = { ...settings, skippedPayPeriods: skippedList };
  writeJSON(SETTINGS_PATH, updatedSettings);

  const doneAlert = new Alert();
  doneAlert.title = "Pay Period Skipped ✓";
  doneAlert.message = "Your payment splits have been updated.";
  doneAlert.addAction("Done");
  await doneAlert.present();
}

async function addManualCardInteractive() {
  const alert = new Alert();
  alert.title = "Add a Card Manually";
  alert.message =
    "For cards not connected to YNAB.\n" +
    "You'll be prompted to update the balance\n" +
    "7 days after each statement closes.";
  alert.addTextField("Nickname (e.g. Spouse Visa)");
  alert.addTextField("Current statement balance (e.g. 450.00)");
  alert.addTextField("Statement closing day of month (e.g. 11)");
  alert.addTextField("Due date day of month (e.g. 7)");
  alert.addAction("Add Card");
  alert.addCancelAction("Cancel");

  const result = await alert.present();
  if (result === -1) return null;

  const nickname = alert.textFieldValue(0).trim();
  const statementBalance = parseFloat(alert.textFieldValue(1).trim());
  const closingDay = alert.textFieldValue(2).trim();
  const dueDay = alert.textFieldValue(3).trim();

  // Validate nickname
  const nicknameCheck = validateNickname(nickname);
  if (!nicknameCheck.valid) {
    const errAlert = new Alert();
    errAlert.title = "Invalid Nickname";
    errAlert.message = nicknameCheck.reason;
    errAlert.addAction("Try Again");
    await errAlert.present();
    return addManualCardInteractive();
  }

  if (isNaN(statementBalance) || statementBalance < 0) {
    const errAlert = new Alert();
    errAlert.title = "Invalid Balance";
    errAlert.message = "Please enter a valid dollar amount, e.g. 450.00";
    errAlert.addAction("Try Again");
    await errAlert.present();
    return addManualCardInteractive();
  }

  const cardResult = configureCard({
    ynabId: null, // no YNAB connection
    nickname,
    statementBalance,
    closingDay,
    dueDay,
  });

  if (!cardResult.success) {
    const errAlert = new Alert();
    errAlert.title = "Something looks off";
    errAlert.message = cardResult.error;
    errAlert.addAction("Try Again");
    await errAlert.present();
    return addManualCardInteractive();
  }

  // Ask for payment schedule override
  const existingSettings2 = readJSON(SETTINGS_PATH) || {};
  const globalPrefs2 = {
    paymentFrequency: existingSettings2.paymentFrequency || "weekly",
    paydayName: existingSettings2.paydayName || "thursday",
    paydayOfMonth: existingSettings2.paydayOfMonth || 1,
  };
  const manualPaymentOverride = await askPaymentOverride(nickname, globalPrefs2);

  const freqDesc2 = manualPaymentOverride
    ? (manualPaymentOverride.paymentFrequency === "monthly"
        ? `monthly on the ${manualPaymentOverride.paydayOfMonth}`
        : `${manualPaymentOverride.paymentFrequency} on ${manualPaymentOverride.paydayName}`)
    : "using your default schedule";

  // Confirmation screen
  const confirmAlert = new Alert();
  confirmAlert.title = "Confirm Card Details";
  confirmAlert.message =
    `Nickname:         ${nickname}\n` +
    `Statement balance: $${statementBalance.toFixed(2)}\n` +
    `Closing day:      ${closingDay}th of each month\n` +
    `Due date:         ${dueDay}th of each month\n` +
    `Payments:         ${freqDesc2}\n\n` +
    "Does this look correct?";
  confirmAlert.addAction("Looks good");
  confirmAlert.addDestructiveAction("Start this card over");
  const confirm = await confirmAlert.present();

  if (confirm === 1) {
    return addManualCardInteractive();
  }

  const verifiedCard = {
    ...cardResult.card,
    verified: true,
    lastVerifiedAt: new Date().toISOString().split("T")[0],
    ...(manualPaymentOverride || {}),
  };

  return verifiedCard;
}

async function addBillInteractive() {
  const alert = new Alert();
  alert.title = "Add a Bill";
  alert.message = "Enter the details for this bill.";
  alert.addTextField("Nickname (e.g. Electric)");
  alert.addTextField("Amount owed (e.g. 198.47)");
  alert.addTextField("Due date (YYYY-MM-DD)");
  alert.addAction("Weekly splits");
  alert.addAction("Every-other-payday splits");
  alert.addCancelAction("Skip");

  const result = await alert.present();
  if (result === -1) return null;

  const nickname = alert.textFieldValue(0).trim();
  const amount = alert.textFieldValue(1).trim();
  const dueDate = alert.textFieldValue(2).trim();

  // Ask for payment schedule override
  const existingSettings3 = readJSON(SETTINGS_PATH) || {};
  const globalPrefs3 = {
    paymentFrequency: existingSettings3.paymentFrequency || "weekly",
    paydayName: existingSettings3.paydayName || "thursday",
    paydayOfMonth: existingSettings3.paydayOfMonth || 1,
  };
  const billPaymentOverride = await askPaymentOverride(nickname, globalPrefs3);

  const billResult = createBill({
    nickname,
    amount,
    dueDate,
    splitFrequency: billPaymentOverride?.paymentFrequency || globalPrefs3.paymentFrequency || "weekly",
  });

  if (!billResult.success) {
    const errAlert = new Alert();
    errAlert.title = "Something looks off";
    errAlert.message = billResult.error;
    errAlert.addAction("Try Again");
    await errAlert.present();
    return addBillInteractive();
  }

  // Apply payment override if set
  const finalBill = {
    ...billResult.bill,
    ...(billPaymentOverride || {}),
  };

  return finalBill;
}

// ─────────────────────────────────────────
// MAIN SETUP FLOW
// ─────────────────────────────────────────

async function runSetup() {
  const existingSettings = readJSON(SETTINGS_PATH);

  // ── Migrate old settings format ──
  // If existing settings have paydayName but no paymentFrequency,
  // carry over as weekly (preserves Thursday/weekly setup)
  if (existingSettings &&
      existingSettings.paydayName &&
      !existingSettings.paymentFrequency) {
    existingSettings.paymentFrequency = "weekly";
    writeJSON(SETTINGS_PATH, existingSettings);
  }

  // If setup already complete, show management menu
  if (existingSettings && existingSettings.setupComplete) {
    const menuAlert = new Alert();
    menuAlert.title = "uninterested";
    menuAlert.message = "Setup is already complete. What would you like to do?";
    menuAlert.addAction("Add a bill");
    menuAlert.addAction("Update statement balances");
    menuAlert.addAction("Skip a pay period");
    menuAlert.addAction("Edit a card");
    menuAlert.addAction("Re-run full setup");
    menuAlert.addAction("Delete all data");
    menuAlert.addCancelAction("Cancel");
    const choice = await menuAlert.present();

    if (choice === 1) {
      await updateStatementBalancesInteractive();
      return;
    }

    if (choice === 2) {
      await skipPayPeriodInteractive();
      return;
    }

    if (choice === 4) {
      // Edit card — coming soon
      const soonAlert = new Alert();
      soonAlert.title = "Coming Soon";
      soonAlert.message =
        "Card editing isn't available yet.\n\n" +
        "For now, use 'Re-run full setup' to start over,\n" +
        "or 'Delete all data' to reset completely.";
      soonAlert.addAction("OK");
      await soonAlert.present();
      return;
    }

    if (choice === 0) {
      const bills = readJSON(BILLS_PATH) || [];
      const bill = await addBillInteractive();
      if (bill) {
        bills.push(bill);
        writeJSON(BILLS_PATH, bills);
        const doneAlert = new Alert();
        doneAlert.title = "Bill Added ✓";
        doneAlert.message = `${bill.billNickname} has been added.`;
        doneAlert.addAction("Done");
        await doneAlert.present();
      }
      return;
    } else if (choice === 5) {
      const confirmAlert = new Alert();
      confirmAlert.title = "Delete All Data?";
      confirmAlert.message = "This will remove all cards, bills, settings, and your YNAB token. This cannot be undone.";
      confirmAlert.addDestructiveAction("Yes, delete everything");
      confirmAlert.addCancelAction("Cancel");
      const confirm = await confirmAlert.present();
      if (confirm === 0) {
        if (FILE_MANAGER.fileExists(CARDS_PATH)) FILE_MANAGER.remove(CARDS_PATH);
        if (FILE_MANAGER.fileExists(BILLS_PATH)) FILE_MANAGER.remove(BILLS_PATH);
        if (FILE_MANAGER.fileExists(SETTINGS_PATH)) FILE_MANAGER.remove(SETTINGS_PATH);
        try { Keychain.remove("uninterested_ynab_token"); } catch (e) {}
        const doneAlert = new Alert();
        doneAlert.title = "All data deleted.";
        doneAlert.message = "uninterested has been reset.";
        doneAlert.addAction("Done");
        await doneAlert.present();
      }
      return;
    } else if (choice === -1) {
      return;
    }
    // choice === 4 (Re-run full setup) falls through to full setup below
  }

  // ── Step 1: Privacy onboarding ──
  await showPrivacyOnboarding();

  // ── Step 2: Payment preference ──
  const paymentPrefs = await askPaymentPreference();

  // ── Step 3: YNAB token ──
  // Check Keychain first — no need to re-enter if already saved
  let token = null;
  try { token = Keychain.get("uninterested_ynab_token"); } catch (e) { token = null; }

  if (!token) {
    token = await askYNABToken();
    if (!token) {
      const cancelAlert = new Alert();
      cancelAlert.title = "Setup cancelled.";
      cancelAlert.message = "You can run setup again any time.";
      cancelAlert.addAction("OK");
      await cancelAlert.present();
      return;
    }
    Keychain.set("uninterested_ynab_token", token);
  }

  // ── Step 4: Fetch cards from YNAB ──
  const loadingAlert = new Alert();
  loadingAlert.title = "Connecting to YNAB...";
  loadingAlert.message = "Fetching your credit cards.";

  const ynabResult = await fetchYNABAccounts(token);
  if (!ynabResult.success) {
    const errAlert = new Alert();
    errAlert.title = "Could not connect to YNAB";
    errAlert.message = ynabResult.error;
    errAlert.addAction("OK");
    await errAlert.present();
    return;
  }

  // ── Step 5: Configure each card ──
  const cards = [];
  for (const account of ynabResult.accounts) {
    const card = await configureCardInteractive(account);
    if (card) cards.push(card);
  }

  // ── Step 5b: Add manual cards (not in YNAB) ──
  let addingManualCards = true;
  while (addingManualCards) {
    const manualPrompt = new Alert();
    manualPrompt.title = "Any Cards Not in YNAB?";
    manualPrompt.message =
      cards.length > 0
        ? `${cards.length} card(s) added from YNAB.

Do you have any cards that aren't connected to YNAB? (e.g. a spouse's card from the same bank)`
        : "Do you have any credit cards to add manually?";
    manualPrompt.addAction("Add a card manually");
    manualPrompt.addAction("No, move on");
    const manualChoice = await manualPrompt.present();

    if (manualChoice === 0) {
      const manualCard = await addManualCardInteractive();
      if (manualCard) cards.push(manualCard);
    } else {
      addingManualCards = false;
    }
  }

  // ── Step 6: Add bills ──
  const bills = [];
  let addingBills = true;

  while (addingBills) {
    const billPromptAlert = new Alert();
    billPromptAlert.title = "Add a Bill?";
    billPromptAlert.message =
      bills.length === 0
        ? "Would you like to track any bills alongside your cards?"
        : `${bills.length} bill(s) added. Add another?`;
    billPromptAlert.addAction("Add a bill");
    billPromptAlert.addAction("Done with bills");
    const billChoice = await billPromptAlert.present();

    if (billChoice === 0) {
      const bill = await addBillInteractive();
      if (bill) bills.push(bill);
    } else {
      addingBills = false;
    }
  }

  // ── Step 7: Save everything ──
  const settings = {
    // Payment preferences
    paymentFrequency: paymentPrefs.paymentFrequency || "weekly",
    paydayName: paymentPrefs.paydayName || "thursday",
    paydayOfMonth: paymentPrefs.paydayOfMonth || null,
    setupComplete: true,
    onboardingComplete: true,
    lastSyncDate: null,
    budgetId: ynabResult.budgetId,
    version: "1.0.0",
    setupCompletedAt: new Date().toISOString().split("T")[0],
  };

  writeJSON(CARDS_PATH, cards);
  writeJSON(BILLS_PATH, bills);
  writeJSON(SETTINGS_PATH, settings);

  // ── Step 8: Done ──
  const doneAlert = new Alert();
  doneAlert.title = "Setup Complete ✓";
  doneAlert.message =
    `${cards.length} card(s) and ${bills.length} bill(s) configured.\n\n` +
    "Now add the widget to your home screen:\n" +
    "1. Long press your home screen\n" +
    "2. Tap + → search Scriptable\n" +
    "3. Choose medium size\n" +
    "4. Set script to 'widget'\n" +
    "5. Set 'When Interacting' to 'Run Script'";
  doneAlert.addAction("Done");
  await doneAlert.present();
}

// ── Entry point ──
await runSetup();