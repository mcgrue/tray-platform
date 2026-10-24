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
  const command = shellQuote(nodePath) + " " + shellQuote(bridgePath);
  const commandWindows = "& " + powershellQuote(nodePath) + " " + powershellQuote(bridgePath);
  const handler = {
    type: "command", command, command_windows: commandWindows,
    async: true, timeout: 5, statusMessage: "Notifying Tray Platform",
  };
  const definitions = [
    { event: "PreToolUse", matcher: MATCHER, handler },
    { event: "PostToolUse", matcher: "^request_user_input$", handler: { ...handler, statusMessage: "Dismissing answered questions" } },
    { event: "UserPromptSubmit", handler: { ...handler, statusMessage: "Dismissing answered questions" } },
    { event: "Stop", handler: { ...handler, statusMessage: "Notifying Tray Platform of completion" } },
  ];
  const addedEvents = [];
  for (const definition of definitions) {
    const { event, matcher, handler: expected } = definition;
    config.hooks[event] ??= [];
    if (!Array.isArray(config.hooks[event])) throw new Error("Invalid " + event + " hooks");
    let present = false;
    for (const group of config.hooks[event]) {
      for (const existing of group.hooks || []) {
        if (existing.command === command || existing.command_windows === commandWindows) {
          if (group.matcher !== matcher || Object.keys(expected).some(key => existing[key] !== expected[key])) {
            throw new Error("Existing Tray Platform " + event + " hook differs; review it before updating");
          }
          present = true;
        }
      }
    }
    if (!present) {
      config.hooks[event].push({ ...(matcher && { matcher }), hooks: [expected] });
      addedEvents.push(event);
    }
  }
  fs.mkdirSync(directory, { recursive: true });
  const completionBackup = replaceWithBackup(path.join(directory, "attention-completion-dismissal.cjs"), fs.readFileSync(path.join(__dirname, "attention-completion-dismissal.cjs")));
  const answersBackup = replaceWithBackup(path.join(directory, "attention-answers.cjs"), fs.readFileSync(path.join(__dirname, "attention-answers.cjs")));
  const bridgeBackup = replaceWithBackup(bridgePath, fs.readFileSync(path.join(__dirname, "attention-hook.cjs")));
  let hooksBackup = null;
  if (addedEvents.length) {
    const current = fs.existsSync(hooksPath) ? fs.readFileSync(hooksPath) : null;
    if (before ? !current?.equals(before) : current !== null) throw new Error("hooks.json changed during installation");
    hooksBackup = replaceWithBackup(hooksPath, Buffer.from(JSON.stringify(config, null, 2) + "\n"));
  }
  return { hooksPath, bridgePath, command, commandWindows, added: addedEvents.length > 0, addedEvents,
    backups: [bridgeBackup, answersBackup, completionBackup, hooksBackup].filter(Boolean) };
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(install(), null, 2));
    console.log("Review and trust the Tray Platform PreToolUse, PostToolUse, UserPromptSubmit, and Stop hooks in Codex /hooks. After adding hooks, wait for active work to finish, then use Developer: Reload Window in existing VS Code windows or restart Codex CLI. Existing sessions retain their loaded hook configuration.");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { install };
