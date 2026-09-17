/**
 * backup.js
 * uninterested — Backup and restore script
 *
 * Exports your cards, bills, and settings to a dated
 * backup file in iCloud. Restores from any saved backup.
 *
 * In Scriptable, name this script: backup
 *
 * Backups are saved to:
 *   iCloud/Scriptable/uninterested_backup_YYYY-MM-DD.json
 *
 * Your YNAB token is NOT included in backups —
 * it lives in iOS Keychain and is never written to a file.
 */

// ─────────────────────────────────────────
// FILE PATHS
// ─────────────────────────────────────────

const FILE_MANAGER = FileManager.iCloud();
const BASE_PATH = FILE_MANAGER.documentsDirectory();

const CARDS_PATH    = `${BASE_PATH}/uninterested_cards.json`;
const BILLS_PATH    = `${BASE_PATH}/uninterested_bills.json`;
const SETTINGS_PATH = `${BASE_PATH}/uninterested_settings.json`;

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

function readJSON(path) {
  try {
    if (!FILE_MANAGER.fileExists(path)) return null;
    return JSON.parse(FILE_MANAGER.readString(path));
  } catch (e) { return null; }
}

function writeJSON(path, data) {
  FILE_MANAGER.writeString(path, JSON.stringify(data, null, 2));
}

function todayString() {
  return new Date().toISOString().split("T")[0];
}

// Find all existing backup files in iCloud
function findBackups() {
  const files = FILE_MANAGER.listContents(BASE_PATH);
  return files
    .filter((f) => f.startsWith("uninterested_backup_") && f.endsWith(".json"))
    .sort()
    .reverse(); // most recent first
}

// ─────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────

async function exportBackup() {
  const cards    = readJSON(CARDS_PATH);
  const bills    = readJSON(BILLS_PATH);
  const settings = readJSON(SETTINGS_PATH);

  if (!cards && !bills && !settings) {
    const alert = new Alert();
    alert.title = "Nothing to Back Up";
    alert.message = "No data found. Run setup first.";
    alert.addAction("OK");
    await alert.present();
    return;
  }

  const backup = {
    exportedAt: new Date().toISOString(),
    version: "1.0.0",
    cards:    cards    || [],
    bills:    bills    || [],
    settings: settings || {},
    note: "YNAB token not included — stored in iOS Keychain only.",
  };

  const filename = `uninterested_backup_${todayString()}.json`;
  const backupPath = `${BASE_PATH}/${filename}`;

  writeJSON(backupPath, backup);

  const cardCount    = (cards    || []).length;
  const billCount    = (bills    || []).length;

  const alert = new Alert();
  alert.title = "Backup Saved ✓";
  alert.message =
    `Saved: ${filename}\n\n` +
    `Cards:    ${cardCount}\n` +
    `Bills:    ${billCount}\n` +
    `Settings: included\n\n` +
    "Your YNAB token was NOT included\n" +
    "(it stays safely in iOS Keychain).";
  alert.addAction("Done");
  await alert.present();
}

// ─────────────────────────────────────────
// RESTORE
// ─────────────────────────────────────────

async function restoreBackup() {
  const backups = findBackups();

  if (backups.length === 0) {
    const alert = new Alert();
    alert.title = "No Backups Found";
    alert.message =
      "No backup files found in iCloud.\n" +
      "Run an export first.";
    alert.addAction("OK");
    await alert.present();
    return;
  }

  // Let user pick which backup to restore
  const pickAlert = new Alert();
  pickAlert.title = "Choose a Backup";
  pickAlert.message = "Select the backup to restore.\nYour current data will be replaced.";

  for (const filename of backups) {
    // Extract date from filename for display
    const date = filename
      .replace("uninterested_backup_", "")
      .replace(".json", "");
    pickAlert.addAction(date);
  }
  pickAlert.addCancelAction("Cancel");

  const index = await pickAlert.present();
  if (index === -1) return;

  const selectedFile = backups[index];
  const backupPath = `${BASE_PATH}/${selectedFile}`;
  const backup = readJSON(backupPath);

  if (!backup) {
    const alert = new Alert();
    alert.title = "Could Not Read Backup";
    alert.message = "The backup file may be corrupted.";
    alert.addAction("OK");
    await alert.present();
    return;
  }

  // Restore files
  if (backup.cards)    writeJSON(CARDS_PATH,    backup.cards);
  if (backup.bills)    writeJSON(BILLS_PATH,    backup.bills);
  if (backup.settings) writeJSON(SETTINGS_PATH, backup.settings);

  const alert = new Alert();
  alert.title = "Restore Complete ✓";
  alert.message =
    `Restored from: ${selectedFile}\n\n` +
    `Cards:    ${(backup.cards    || []).length}\n` +
    `Bills:    ${(backup.bills    || []).length}\n` +
    `Settings: restored\n\n` +
    "Your YNAB token was not affected.\n" +
    "Open the widget to verify your data.";
  alert.addAction("Done");
  await alert.present();
}

// ─────────────────────────────────────────
// DELETE OLD BACKUPS
// ─────────────────────────────────────────

async function deleteOldBackups() {
  const backups = findBackups();

  if (backups.length === 0) {
    const alert = new Alert();
    alert.title = "No Backups Found";
    alert.message = "Nothing to delete.";
    alert.addAction("OK");
    await alert.present();
    return;
  }

  const pickAlert = new Alert();
  pickAlert.title = "Delete a Backup";
  pickAlert.message = "Select a backup to delete.";

  for (const filename of backups) {
    const date = filename
      .replace("uninterested_backup_", "")
      .replace(".json", "");
    pickAlert.addDestructiveAction(date);
  }
  pickAlert.addCancelAction("Cancel");

  const index = await pickAlert.present();
  if (index === -1) return;

  const selectedFile = backups[index];
  const backupPath = `${BASE_PATH}/${selectedFile}`;
  FILE_MANAGER.remove(backupPath);

  const alert = new Alert();
  alert.title = "Backup Deleted";
  alert.message = `Removed: ${selectedFile}`;
  alert.addAction("Done");
  await alert.present();
}

// ─────────────────────────────────────────
// MAIN MENU
// ─────────────────────────────────────────

async function run() {
  const backups = findBackups();
  const backupCount = backups.length;
  const latest = backupCount > 0
    ? backups[0].replace("uninterested_backup_", "").replace(".json", "")
    : "none";

  const menu = new Alert();
  menu.title = "💾 uninterested Backup";
  menu.message =
    `Saved backups: ${backupCount}\n` +
    `Latest: ${latest}`;
  menu.addAction("Export backup (today)");
  menu.addAction("Restore from backup");
  menu.addDestructiveAction("Delete a backup");
  menu.addCancelAction("Cancel");

  const choice = await menu.present();

  if (choice === 0) await exportBackup();
  if (choice === 1) await restoreBackup();
  if (choice === 2) await deleteOldBackups();
}

await run();