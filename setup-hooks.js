#!/usr/bin/env node
// Wires the Clawd Deck hooks into a Claude Code settings.json, idempotently.
// Run it once after cloning:            node setup-hooks.js
// For an account profile's directory:   node setup-hooks.js --dir ~/.claude-profiles/personal
//
// It only appends missing entries, never touches anything else in the file,
// and saves a backup next to it before the first change.

const fs = require('fs');
const path = require('path');
const os = require('os');

const argIdx = process.argv.indexOf('--dir');
const rawDir = argIdx > -1 ? process.argv[argIdx + 1] : null;
const targetDir = rawDir
  ? path.resolve(rawDir.replace(/^~(?=\/|$)/, os.homedir()))
  : path.join(os.homedir(), '.claude');
const settingsPath = path.join(targetDir, 'settings.json');
const emit = path.join(__dirname, 'hooks', 'emit.sh');

const EVENTS = ['UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd', 'Notification', 'PreCompact', 'PostToolUse'];

let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
settings.hooks = settings.hooks || {};

let added = 0;
for (const ev of EVENTS) {
  const list = settings.hooks[ev] = settings.hooks[ev] || [];
  if (JSON.stringify(list).includes('/hooks/emit.sh')) continue; // already wired
  const entry = { hooks: [{ type: 'command', command: `${emit} ${ev}` }] };
  if (ev === 'PostToolUse') entry.matcher = 'TodoWrite';
  list.push(entry);
  added++;
}

if (added === 0) {
  console.log(`Already wired: ${settingsPath}`);
} else {
  fs.mkdirSync(targetDir, { recursive: true });
  if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, settingsPath + '.before-clawd-deck');
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`Wired ${added} hook event(s) into ${settingsPath}`);
  console.log('Claude Code reloads hooks live, so running sessions start reporting without a restart.');
}
