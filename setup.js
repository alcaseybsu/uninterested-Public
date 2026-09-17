/**
 * setup.js
 * uninterested — One-time configuration script
 *
 * Run once when the user first installs uninterested.
 * Handles YNAB connection, card configuration, payday
 * preference, bill entry, and the privacy onboarding message.
 *
 * Can be re-run at any time to update cards, bills, or settings.
 *
 * Imported by widget.js for verification logic.
 */

const { validateNickname, sanitizeObject, scrubString } = require("./sanitizer");
const { createBill, SPLIT_FREQUENCY } = require("./bills");
const { DAY_NAME_TO_INDEX } = require("./calculator");

// ─────────────────────────────────────────
// YNAB API
// ─────────────────────────────────────────

/** @constant {string} YNAB_API_BASE - Base URL for all YNAB API requests */
const YNAB_API_BASE = "https://api.youneedabudget.com/v1";

/**
 * Fetch all credit card accounts from YNAB.
 *
 * The real YNAB account name is returned for display once
 * during setup so the user can match cards to nicknames.
 * It is never stored — only the YNAB account ID is kept.
 *
 * @param {string} token - YNAB personal access token
 * @returns {Promise<{
 *   success: boolean,
 *   accounts?: Array<{ ynabId: string, ynabName: string, balance: number }>,
 *   error?: string
 * }>}
 */
async function fetchYNABAccounts(token) {
  try {
    const response = await fetch(`${YNAB_API_BASE}/budgets/default/accounts`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      if (response.status === 401) {
        return { success: false, error: "Invalid YNAB token. Please check and try again." };
      }
      return { success: false, error: `YNAB returned an error: ${response.status}` };
    }

    const data = await response.json();
    const accounts = data.data.accounts;

    // Filter to open, active credit cards only
    const creditCards = accounts.filter(
      (a) => a.type === "creditCard" && !a.closed && !a.deleted
    );

    // Return only what we need — ynabName shown once, never stored
    // Note: YNAB stores all amounts in milliunits (1000 = $1.00)
    return {
      success: true,
      accounts: creditCards.map((a) => ({
        ynabId: a.id,                          // random UUID, not personally identifying
        ynabName: a.name,                      // shown once for matching, then discarded
        balance: Math.abs(a.balance / 1000),   // convert milliunits to dollars
      })),
    };
  } catch (err) {
    return { success: false, error: "Could not connect to YNAB. Check your internet connection." };
  }
}

// ─────────────────────────────────────────
// CARD CONFIGURATION
// ─────────────────────────────────────────

/**
 * Configure a single credit card for tracking.
 * The user assigns a nickname and enters their billing cycle details.
 * The real YNAB account name is discarded after this step.
 *
 * @param {Object} input - Card configuration details
 * @param {string} input.ynabId - YNAB account UUID (from fetchYNABAccounts)
 * @param {string} input.nickname - User-chosen label for this card
 * @param {number|string} input.closingDay - Day of month statement closes (1-31)
 * @param {number|string} input.dueDaysAfterClosing - Days after closing that payment is due
 * @returns {{ success: boolean, card?: Object, error?: string }}
 */
function configureCard(input) {
  // Validate nickname
  const nicknameCheck = validateNickname(input.nickname);
  if (!nicknameCheck.valid) {
    return { success: false, error: nicknameCheck.reason };
  }

  // Validate closing day
  const closingDay = parseInt(input.closingDay);
  if (isNaN(closingDay) || closingDay < 1 || closingDay > 31) {
    return { success: false, error: "Closing day must be between 1 and 31." };
  }

  // Validate due days
  const dueDays = parseInt(input.dueDaysAfterClosing);
  if (isNaN(dueDays) || dueDays < 1 || dueDays > 60) {
    return { success: false, error: "Due days after closing must be between 1 and 60." };
  }

  const card = {
    id: generateCardId(),
    ynabId: input.ynabId,           // links to YNAB for balance sync
    nickname: input.nickname.trim(),
    closingDay,
    dueDaysAfterClosing: dueDays,
    statementBalance: 0,            // populated on first YNAB sync
    currentBalance: 0,              // populated on first YNAB sync
    lastClosingDate: null,          // set after first cycle completes
    nextDueDate: null,              // calculated from closing date + due days
    verified: false,                // true after user confirms first cycle
    snoozedVerification: false,     // true if user has used their one snooze
    createdAt: new Date().toISOString().split("T")[0],
  };

  return { success: true, card };
}

// ─────────────────────────────────────────
// USER SETTINGS
// ─────────────────────────────────────────

/**
 * Create the initial user settings object.
 * Saved to iCloud as uninterested_settings.json.
 *
 * @param {Object} input - Setup preferences from user
 * @param {string} input.paydayName - Day of week user gets paid (e.g. "friday")
 * @returns {{ success: boolean, settings?: Object, error?: string }}
 */
function createUserSettings(input) {
  const paydayName = input.paydayName?.toLowerCase().trim();

  if (!DAY_NAME_TO_INDEX.hasOwnProperty(paydayName)) {
    return {
      success: false,
      error: `"${paydayName}" isn't a valid day. Please use a day name like "friday".`,
    };
  }

  const settings = {
    paydayName,                // e.g. "thursday"
    setupComplete: false,      // true after all cards configured
    onboardingComplete: false, // true after privacy message dismissed
    lastSyncDate: null,        // date of last successful YNAB sync
    version: "1.0.0",
  };

  return { success: true, settings };
}

// ─────────────────────────────────────────
// PRIVACY ONBOARDING
// ─────────────────────────────────────────

/**
 * Return the content for the privacy onboarding message.
 * Displayed once on first launch and always accessible in Settings.
 * No data is collected by showing this screen.
 *
 * @returns {{
 *   title: string,
 *   sections: Array<{ heading: string, points: string[] }>,
 *   dismissLabel: string,
 *   learnMoreLabel: string
 * }}
 */
function getPrivacyOnboardingMessage() {
  return {
    title: "🔒 Your Privacy, By Design",
    sections: [
      {
        heading: "We never see or store:",
        points: [
          "Your name or address",
          "Full card numbers",
          "Phone numbers or email",
          "Your YNAB login credentials",
          "Any uploaded images or PDFs",
        ],
      },
      {
        heading: "What actually happens:",
        points: [
          "YNAB connects via a secure token — we never see your password",
          "Uploaded files are read, then immediately discarded — only the numbers are kept",
          "Your data lives on YOUR device, not our servers",
          "You can delete everything instantly in Settings",
        ],
      },
      {
        heading: "Your cards:",
        points: [
          "Identified only by nicknames you choose",
          "Never stored by account number or issuer name",
          "Last 4 digits are optional and only used if you choose them as a nickname",
        ],
      },
    ],
    dismissLabel: "Got it",
    learnMoreLabel: "Learn more",
  };
}

// ─────────────────────────────────────────
// SETUP COMPLETION
// ─────────────────────────────────────────

/**
 * Mark setup as complete after all cards and bills are configured.
 * The widget will not display data until this is called.
 *
 * Setup sequence:
 *   1. createUserSettings()      → save payday + preferences
 *   2. fetchYNABAccounts()       → pull cards from YNAB
 *   3. configureCard()           → for each card
 *   4. createBill()              → for each bill (optional)
 *   5. markSetupComplete()       → unlock the widget
 *
 * @param {Object} settings - The settings object from createUserSettings()
 * @returns {Object} - Updated settings with setupComplete: true
 */
function markSetupComplete(settings) {
  return {
    ...settings,
    setupComplete: true,
    setupCompletedAt: new Date().toISOString().split("T")[0],
  };
}

// ─────────────────────────────────────────
// VERIFICATION
// ─────────────────────────────────────────

/**
 * Find all cards that need the user to verify their due date.
 * Returns cards that have never been verified, or cards where
 * the user has already used their one snooze.
 *
 * @param {Object[]} cards - All configured card objects
 * @returns {Object[]} - Cards requiring verification
 */
function getCardsNeedingVerification(cards) {
  return cards.filter((card) => {
    if (!card.verified) return true;
    if (card.snoozedVerification) return true;
    return false;
  });
}

/**
 * Handle a user's request to snooze a verification reminder.
 *
 * Rules:
 *   - First snooze: allowed. Sets snoozedVerification: true.
 *   - Second snooze attempt: blocked. Returns error message.
 *     Card splits are hidden until the user verifies.
 *
 * @param {Object} card - The card the user wants to snooze
 * @returns {{ success: boolean, card?: Object, blocked?: boolean, error?: string }}
 */
function snoozeVerification(card) {
  if (card.snoozedVerification) {
    return {
      success: false,
      blocked: true,
      error: "Please verify your due date to continue tracking this card.",
    };
  }

  return {
    success: true,
    card: { ...card, snoozedVerification: true },
  };
}

/**
 * Mark a card as verified after the user confirms their due date.
 * Clears the snooze flag and records when verification happened.
 *
 * @param {Object} card - The card being verified
 * @param {string} confirmedDueDate - The due date the user confirmed "YYYY-MM-DD"
 * @returns {Object} - Updated card with verified: true
 */
function verifyCard(card, confirmedDueDate) {
  return {
    ...card,
    verified: true,
    snoozedVerification: false,
    nextDueDate: confirmedDueDate,
    lastVerifiedAt: new Date().toISOString().split("T")[0],
  };
}

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

/**
 * Generate a unique, non-identifying card ID.
 * Uses timestamp + random string to avoid collisions.
 *
 * @returns {string} - e.g. "card_1715123456789_a3f9k"
 */
function generateCardId() {
  return "card_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7);
}

// ─────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────

module.exports = {
  fetchYNABAccounts,
  configureCard,
  createUserSettings,
  getPrivacyOnboardingMessage,
  markSetupComplete,
  getCardsNeedingVerification,
  snoozeVerification,
  verifyCard,
};