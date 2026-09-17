// update.js
// uninterested — GitHub loader
// Run this any time you want to pull the latest
// setup.js, widget.js, or backup.js from GitHub.
// This is the ONLY script you ever need to update manually.

const BASE_URL = "https://raw.githubusercontent.com/alcaseybsu/uninterested-Public/main";

const FILES = [
  { url: `${BASE_URL}/setup.js`,  name: "setup"  },
  { url: `${BASE_URL}/widget.js`, name: "widget" },
  { url: `${BASE_URL}/backup.js`, name: "backup" },
];

const fm = FileManager.iCloud();
const dir = fm.documentsDirectory();

// Ask which files to update
const alert = new Alert();
alert.title = "Update uninterested";
alert.message = "Which scripts do you want to update from GitHub?";
alert.addAction("All three (setup, widget, backup)");
alert.addAction("Just setup");
alert.addAction("Just widget");
alert.addAction("Just backup");
alert.addCancelAction("Cancel");

const choice = await alert.present();
if (choice === -1) Script.complete();

// choice 0 = all three
// choice 1 = just setup  → FILES[0]
// choice 2 = just widget → FILES[1]
// choice 3 = just backup → FILES[2]
const toUpdate = choice === 0
  ? FILES
  : [FILES[choice - 1]];

let updated = [];
let failed = [];

for (const file of toUpdate) {
  try {
    const req = new Request(file.url);
    const code = await req.loadString();

    if (!code || code.length < 100) {
      failed.push(file.name);
      continue;
    }

    fm.writeString(`${dir}/${file.name}.js`, code);
    updated.push(file.name);
  } catch (e) {
    failed.push(file.name);
  }
}

// Show result
const result = new Alert();
result.title = updated.length > 0 ? "Update Complete ✓" : "Update Failed";
result.message =
  (updated.length > 0 ? `Updated: ${updated.join(", ")}` : "") +
  (failed.length > 0 ? `\nFailed: ${failed.join(", ")}` : "");
result.addAction("Done");
await result.present();

Script.complete();