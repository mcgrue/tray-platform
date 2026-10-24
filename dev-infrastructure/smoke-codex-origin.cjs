// Run from a VS Code Codex session with: node node_modules/electron/cli.js dev-infrastructure/smoke-codex-origin.cjs
// Requires yarn pre-build. Uses isolated data; briefly focuses the originating editor.
const assert = require("assert").strict;
const fs = require("fs"), os = require("os"), path = require("path");
const { spawn, spawnSync } = require("child_process");
const { app } = require("electron");
for (const stream of [process.stdout, process.stderr]) stream.on("error", error => { if (error.code !== "EPIPE") throw error; });
require("./smoke-environment.cjs");
const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "tray-codex-origin-"));
const reportPath = process.env.TRAY_PLATFORM_SMOKE_REPORT || path.join(dataPath, "result.json");
const powershell = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
const captured = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-File", path.join(__dirname, "../src/main/resources/desktop-helper.ps1")], {
  windowsHide: true, encoding: "utf8", input: JSON.stringify({ command: "foreground", appPid: process.pid }), timeout: 10000,
});
const originalWindow = captured.status === 0 ? JSON.parse(captured.stdout.replace(/^\uFEFF/, "")).result : undefined;
app.setName("Tray Codex origin smoke " + process.pid);
Object.assign(process.env, { TRAY_PLATFORM_USER_DATA: dataPath, TRAY_PLATFORM_PORT: "0", WATCH_MODE: "", BREADITOR_DEV_MODE: "" });
let application, failed = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(label, predicate) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(150); }
  throw new Error("Timeout: " + label);
}
async function clickGo(mainWindow) {
  // A JavaScript .click() does not grant Windows foreground permission. Exercise
  // the real mouse-input path, as a user clicking Go does.
  mainWindow.setAlwaysOnTop(true); mainWindow.show();
  // The synthetic question has no transcript; its asynchronous error changes
  // layout. Collapse that unrelated panel before measuring native click coordinates.
  await mainWindow.webContents.executeJavaScript(`(() => {
    const editor = document.querySelector('[data-codex-question]');
    if (editor) editor.open = false;
  })()`);
  await sleep(250);
  const point = await mainWindow.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelector("main article").querySelectorAll("button")].find(button => button.textContent === "Go");
    window.__originSmokeGoClicked = false;
    button.addEventListener("click", () => { window.__originSmokeGoClicked = true; }, { once: true });
    button.scrollIntoView({ block: "center" });
    const rect = button.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  const handle = mainWindow.getNativeWindowHandle().readBigUInt64LE().toString();
  const command = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SmokeMouse {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
}
'@
[void][SmokeMouse]::SetProcessDPIAware()
$handle = [IntPtr]${handle}
$scale = [SmokeMouse]::GetDpiForWindow($handle) / 96.0
$point = New-Object SmokeMouse+Point
$point.X = [int](${point.x} * $scale); $point.Y = [int](${point.y} * $scale)
$previous = New-Object SmokeMouse+Point
[void][SmokeMouse]::GetCursorPos([ref]$previous)
[void][SmokeMouse]::ClientToScreen($handle, [ref]$point)
[void][SmokeMouse]::SetCursorPos($point.X, $point.Y)
Start-Sleep -Milliseconds 100
[SmokeMouse]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
[SmokeMouse]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 100
[void][SmokeMouse]::SetCursorPos($previous.X, $previous.Y)
`;
  await new Promise((resolve, reject) => {
    const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let error = ""; child.stderr.on("data", data => { error += data; }); child.on("error", reject);
    child.on("close", code => code ? reject(new Error(error)) : resolve());
  });
  mainWindow.setAlwaysOnTop(false);
}
async function run() {
  application = await require("../dist/main/index.js").applicationReady;
  const { mainWindow, desktop, codexInstances, attention, server } = application;
  mainWindow.webContents.setAudioMuted(true);
  const evaluate = fn => mainWindow.webContents.executeJavaScript(`(${fn.toString()})()`);
  await waitFor("inventory", () => !codexInstances.list().scanning && codexInstances.list().scannedAt);
  const processes = await desktop.listProcesses();
  let ancestor = processes.find(p => p.pid === process.pid);
  const visited = new Set();
  while (ancestor && !/^codex\.exe$/i.test(ancestor.name) && !visited.has(ancestor.pid)) {
    visited.add(ancestor.pid); ancestor = processes.find(p => p.pid === ancestor.parentPid);
  }
  assert(ancestor && /^codex\.exe$/i.test(ancestor.name), "Launch this smoke from a VS Code Codex session");
  const expected = codexInstances.list().instances.find(p => p.codexPid === ancestor.pid);
  assert(expected?.title, "Origin must have a discovered VS Code window");
  const event = { hook_event_name: "PreToolUse", tool_name: "request_user_input_async", session_id: "origin-smoke",
    turn_id: "turn", tool_use_id: "question", cwd: process.cwd(), tool_input: { questions: [{ title: "Verify the originating VS Code window" }] } };
  const hookStart = Date.now();
  await new Promise((resolve, reject) => {
    // Electron in Node mode runs the real CLI entrypoint, including automatic PID capture.
    const child = spawn(process.execPath, [path.join(__dirname, "../integrations/codex/attention-hook.cjs")], {
      windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CODEX_HOME: dataPath,
        TRAY_PLATFORM_ATTENTION_URL: "http://127.0.0.1:" + server.address().port }, stdio: ["pipe", "ignore", "pipe"],
    });
    let error = "";
    child.stderr.on("data", data => { error += data; });
    child.on("error", reject); child.stdin.on("error", reject);
    child.on("close", code => code || error ? reject(new Error(`Hook failed (${code}): ${error}`)) : resolve());
    child.stdin.end(JSON.stringify(event));
  });
  const hookMs = Date.now() - hookStart;
  const item = attention.list().items[0];
  assert.equal(item.origin?.codexPid, expected.codexPid);
  assert.equal(item.origin.vscodePid, expected.vscodePid);
  assert.equal(item.destination, undefined);
  assert.equal(item.origin.title, expected.title);
  await waitFor("enabled Go", () => evaluate(() => {
    const card = document.querySelector("main article");
    return card && [...card.querySelectorAll("button")].some(button => button.textContent === "Go" && !button.disabled) && card.textContent.includes("Codex PID");
  }));
  const windows = await desktop.listWindows();
  const target = windows.filter(w => w.pid === expected.vscodeMainPid && w.title === expected.title);
  assert.equal(target.length, 1, "Origin must map to exactly one native window");
  let navigationScans = 0;
  const refresh = codexInstances.refresh.bind(codexInstances);
  codexInstances.refresh = () => { navigationScans++; return refresh(); };
  const focusStart = Date.now();
  mainWindow.show(); mainWindow.focus();
  await clickGo(mainWindow);
  await waitFor("native Go click registered", () => evaluate(() => window.__originSmokeGoClicked === true));
  await waitFor("Go focuses the originating editor", async () => {
    const failure = await evaluate(() => document.querySelector('main article > [role="alert"]').textContent);
    if (failure) throw new Error(failure);
    return (await desktop.captureForeground())?.hwnd === target[0].hwnd;
  });
  const focusMs = Date.now() - focusStart;
  assert.equal(navigationScans, 0, "Go must use the live cached mapping without rescanning");
  assert.equal(attention.get(item.source, item.id).state, "pending", "Go must not dismiss the item");
  await new Promise(resolve => { mainWindow.webContents.once("did-finish-load", resolve); mainWindow.reload(); });
  await waitFor("origin survives reload", () => evaluate(() => document.querySelector("main article")?.textContent.includes("Codex PID")));

  // Check the chooser path as well as the card button, including surfaced failures.
  const stale = { ...item.origin, codexStartedAt: "2000-01-01T00:00:00Z" };
  await attention.upsert("codex", "stale-origin", { title: "Stale origin smoke", origin: stale });
  mainWindow.webContents.send("navigation-show", {});
  await waitFor("chooser enabled for automatic origin", () => evaluate(() => {
    const panel = document.querySelector('[data-navigation-chooser]');
    return panel && !panel.hidden && [...panel.querySelectorAll("button")].some(button => button.textContent === "Go" && !button.disabled);
  }));
  mainWindow.show(); mainWindow.focus();
  await evaluate(() => {
    const panel = document.querySelector('[data-navigation-chooser]');
    [...panel.querySelectorAll('[role="option"]')].find(option => option.textContent.includes("Stale origin smoke")).click();
    [...panel.querySelectorAll("button")].find(button => button.textContent === "Go").click();
  });
  await waitFor("stale origin error", () => evaluate(() => document.querySelector('[data-navigation-chooser]').textContent.includes("not in the cached mapping")));
  assert.equal(navigationScans, 0, "An unmapped origin must not trigger a scan");
  assert.equal(attention.get("codex", "stale-origin").state, "pending");

  // Exercise the native last-moment guards without changing the target window.
  await assert.rejects(() => desktop.activate(target[0], { title: "wrong title", processes: [] }), /title changed/);
  await assert.rejects(() => desktop.activate(target[0], { title: target[0].title, processes: [{ pid: expected.codexPid, startedAt: stale.codexStartedAt }] }), /process has changed/);
  await evaluate(() => [...document.querySelector('[data-navigation-chooser]').querySelectorAll("button")].find(button => button.textContent === "Close chooser").click());
  await attention.setState("codex", "stale-origin", "done");
  mainWindow.setSize(1100, 1000);
  await sleep(250);
  fs.writeFileSync(path.join(dataPath, "codex-origin.png"), (await mainWindow.webContents.capturePage()).toPNG());
  fs.writeFileSync(reportPath, JSON.stringify({ passed: true, dataPath, hookMs, focusMs, origin: item.origin, target: target[0],
    checks: ["real hook ancestry", "enabled Go", "cached mapping without rescan", "native foreground HWND", "reload", "chooser stale origin error", "native title and PID guards", "item remains pending"] }, null, 2));
}
const watchdog = setTimeout(() => { fs.writeFileSync(reportPath, JSON.stringify({ passed: false, error: "Smoke timed out" })); app.exit(1); }, 150000);
run().catch(async error => {
  failed = true;
  if (application) fs.writeFileSync(path.join(dataPath, "failure.png"), (await application.mainWindow.webContents.capturePage()).toPNG());
  fs.writeFileSync(reportPath, JSON.stringify({ passed: false, dataPath, error: error.stack || String(error) }));
}).finally(async () => {
  if (originalWindow && application) await application.desktop.activate(originalWindow).catch(() => {});
  clearTimeout(watchdog);
  app.once("will-quit", () => app.exit(failed ? 1 : 0));
  app.quit();
});
