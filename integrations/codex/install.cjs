#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const os = require("os");
const { randomUUID } = require("crypto");
const { MATCHER } = require("./attention-hook.cjs");

const powershellQuote = value => "'" + value.replace(/'/g, "''") + "'";
const shellQuote = value => "'" + value.replace(/'/g, "'\\''") + "'";

function replaceWithBackup(file, bytes) {
  const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
  if (before?.equals(bytes)) return null;
  const backup = before ? file + ".backup-" + randomUUID() : null;
  if (backup) fs.writeFileSync(backup, before, { flag: "wx" });
  const temporary = file + ".new-" + randomUUID();
  fs.writeFileSync(temporary, bytes, { flag: "wx" });
  const current = fs.existsSync(file) ? fs.readFileSync(file) : null;
  if (before ? !current?.equals(before) : current !== null) throw new Error("File changed during installation: " + file);
  fs.renameSync(temporary, file);
  return backup;
}

function install({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), nodePath = process.execPath } = {}) {
  const directory = path.join(path.resolve(codexHome), "tray-platform");
  const hooksPath = path.join(path.resolve(codexHome), "hooks.json");
  const bridgePath = path.join(directory, "attention-hook.cjs");
  const before = fs.existsSync(hooksPath) ? fs.readFileSync(hooksPath) : null;
  const config = before ? JSON.parse(before.toString("utf8").replace(/^\uFEFF/, "")) : {};
  if (!config || Array.isArray(config) || typeof config !== "object") throw new Error("Invalid hooks.json");
  config.hooks ??= {};
  if (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) throw new Error("Invalid hooks object");
  config.hooks.PreToolUse ??= [];
  if (!Array.isArray(config.hooks.PreToolUse)) throw new Error("Invalid PreToolUse hooks");
  const command = shellQuote(nodePath) + " " + shellQuote(bridgePath);
  const commandWindows = "& " + powershellQuote(nodePath) + " " + powershellQuote(bridgePath);
  const handler = {
    type: "command", command, command_windows: commandWindows,
    async: true, timeout: 5, statusMessage: "Notifying Tray Platform",
  };
  let present = false;
  for (const group of config.hooks.PreToolUse) {
    for (const existing of group.hooks || []) {
      if (existing.command === command || existing.command_windows === commandWindows) {
        if (group.matcher !== MATCHER || Object.keys(handler).some(key => existing[key] !== handler[key])) {
          throw new Error("Existing Tray Platform hook differs; review it before updating");
        }
        present = true;
      }
    }
  }
  if (!present) config.hooks.PreToolUse.push({ matcher: MATCHER, hooks: [handler] });
  fs.mkdirSync(directory, { recursive: true });
  const bridgeBackup = replaceWithBackup(bridgePath, fs.readFileSync(path.join(__dirname, "attention-hook.cjs")));
  let hooksBackup = null;
  if (!present) {
    const current = fs.existsSync(hooksPath) ? fs.readFileSync(hooksPath) : null;
    if (before ? !current?.equals(before) : current !== null) throw new Error("hooks.json changed during installation");
    hooksBackup = replaceWithBackup(hooksPath, Buffer.from(JSON.stringify(config, null, 2) + "\n"));
  }
  return { hooksPath, bridgePath, command, commandWindows, added: !present, backups: [bridgeBackup, hooksBackup].filter(Boolean) };
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(install(), null, 2));
    console.log("Review and trust the new PreToolUse hook in Codex /hooks. Existing sessions may need to be reopened.");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { install };
