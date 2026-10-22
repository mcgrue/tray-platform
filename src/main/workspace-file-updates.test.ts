import { promises as fs } from "fs";
import { execFileSync } from "child_process";
import os from "os";
import path from "path";
import { CodexInstance } from "../shared/codex-instances";
import { CodexDiscovery } from "./codex-discovery";
import { CodexFileUpdates, CodexTurnOwner, recordedCodexEdits } from "./workspace-file-updates";

const base = Date.parse("2026-10-20T10:00:00Z");
const threadId = "11111111-1111-4111-8111-111111111111";
const turnId = "22222222-2222-4222-8222-222222222222";
const otherTurn = "33333333-3333-4333-8333-333333333333";
const identity = "pid:42:44444444-4444-4444-8444-444444444444";
const instance = (pid = 42): CodexInstance => ({ codexPid: pid, codexStartedAt: new Date(base).toISOString(),
  vscodePid: 1, vscodeStartedAt: new Date(base - 1000).toISOString(), vscodeMainPid: 1, workspace: "D:\\shared-project" });
const patch = (offset: number, extras = {}) => JSON.stringify({ timestamp: new Date(base + offset).toISOString(), type: "event_msg",
  payload: { type: "patch_apply_end", turn_id: turnId, success: true, status: "completed",
    changes: { "source.ts": { type: "update" } }, ...extras } });

async function fixture(lines: string[] = [patch(2000)]) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tray-codex-edits-"));
  const file = path.join(home, "sessions", "session.jsonl");
  await fs.mkdir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify({ type: "session_meta", payload: { id: threadId } }) + "\n" + lines.join("\n") + "\n");
  const owner: CodexTurnOwner = { processIdentity: identity, threadId, turnId, firstObservedAt: base + 1000,
    lastObservedAt: base + 4000, rolloutPath: file };
  const readOwners = jest.fn().mockResolvedValue([owner]);
  const reader = new CodexFileUpdates({ codexHome: home, readOwners, now: () => base + 10000 });
  return { home, file, owner, readOwners, reader };
}

test("counts successful edit events only, excluding failures, empty patches, tool text and malformed records", () => {
  const text = [patch(2000), patch(3000), patch(4000, { success: false }), patch(5000, { status: "failed" }),
    patch(6000, { changes: {} }), JSON.stringify({ type: "response_item", payload: { type: "message", text: patch(9000) } }),
    '{"type":"event_msg","payload":', patch(7000, { turn_id: "not-a-turn" })].join("\n");
  expect(recordedCodexEdits(text)).toEqual([{ turnId, updatedAt: base + 3000 }]);
});

test("reads current completed FileChange items with their completion time and thread identity", () => {
  const current = (status: string, overrides = {}) => JSON.stringify({ type: "event_msg", timestamp: new Date(base + 5000).toISOString(),
    payload: { type: "item_completed", thread_id: threadId, turn_id: turnId, completed_at_ms: base + 4000,
      item: { type: "FileChange", status, changes: [{ path: "source.ts", kind: "update" }] }, ...overrides } });
  expect(recordedCodexEdits([current("completed"), current("failed"), current("completed", { thread_id: otherTurn })].join("\n"), threadId))
    .toEqual([{ turnId, updatedAt: base + 4000 }]);
});

test("attributes edits to their executing process, separating windows in the same workspace", async () => {
  const { reader } = await fixture([patch(2000), patch(9000, { turn_id: otherTurn })]);
  const rows = [instance(), instance(43)];
  try {
    await reader.enrich(rows);
    expect(rows.map(row => row.lastFileUpdatedAt)).toEqual([base + 2000, undefined]);
  } finally { reader.close(); }
});

test("refresh reads appended edits; unrelated project saves and failed edits do not advance the timestamp", async () => {
  const { reader, file, home } = await fixture();
  const rows = [instance()];
  try {
    await reader.enrich(rows);
    await fs.writeFile(path.join(home, "unrelated.ts"), "human edit");
    await fs.appendFile(file, patch(5000, { success: false }) + "\n");
    await reader.enrich(rows);
    expect(rows[0].lastFileUpdatedAt).toBe(base + 2000);
    await fs.appendFile(file, patch(6000) + "\n");
    await reader.enrich(rows);
    expect(rows[0].lastFileUpdatedAt).toBe(base + 6000);
  } finally { reader.close(); }
});

test("rejects PID reuse, edits before ownership, future edits and turns executed by multiple processes", async () => {
  const { reader, owner, readOwners } = await fixture([patch(500), patch(20000)]);
  const rows = [instance()];
  try {
    await reader.enrich(rows);
    expect(rows[0].lastFileUpdatedAt).toBeUndefined();
    readOwners.mockResolvedValue([{ ...owner, firstObservedAt: base - 1000 }]);
    await reader.enrich(rows);
    expect(rows[0].lastFileUpdatedAt).toBeUndefined();
    readOwners.mockResolvedValue([owner, { ...owner, processIdentity: identity.replace("pid:42:", "pid:43:") }]);
    await reader.enrich(rows);
    expect(rows[0].lastFileUpdatedAt).toBeUndefined();
  } finally { reader.close(); }
});

test("rejects ambiguous ownership even when a successful edit exists", async () => {
  const { reader, owner, readOwners } = await fixture();
  const rows = [instance(), instance(43)];
  readOwners.mockResolvedValue([owner, { ...owner, processIdentity: identity.replace("pid:42:", "pid:43:") }]);
  try {
    await reader.enrich(rows);
    expect(rows.every(row => row.lastFileUpdatedAt === undefined)).toBe(true);
  } finally { reader.close(); }
});

test("requires matching session identity and an allowed session path", async () => {
  const { reader, owner, readOwners, file, home } = await fixture();
  const rows = [instance()];
  try {
    await fs.writeFile(file, JSON.stringify({ type: "session_meta", payload: { id: otherTurn } }) + "\n" + patch(2000));
    await reader.enrich(rows);
    expect(rows[0].lastFileUpdatedAt).toBeUndefined();
    readOwners.mockResolvedValue([{ ...owner, rolloutPath: path.join(home, "outside.jsonl") }]);
    await reader.enrich(rows);
    expect(rows[0].lastFileUpdatedAt).toBeUndefined();
  } finally { reader.close(); }
});

test("accepts extended-length Windows session paths inside the Codex profile", async () => {
  const { reader, owner, file, readOwners } = await fixture();
  readOwners.mockResolvedValue([{ ...owner, rolloutPath: path.toNamespacedPath(file) }]);
  try {
    const rows = [instance()];
    await reader.enrich(rows);
    expect(rows[0].lastFileUpdatedAt).toBe(base + 2000);
  } finally { reader.close(); }
});

test("missing, malformed or closed history clears stale timestamps without breaking discovery", async () => {
  const { reader, readOwners } = await fixture();
  const rows = [instance()];
  await reader.enrich(rows);
  expect(rows[0].lastFileUpdatedAt).toBe(base + 2000);
  readOwners.mockRejectedValue(new Error("Schema unavailable"));
  await reader.enrich(rows);
  expect(rows[0].lastFileUpdatedAt).toBeUndefined();
  readOwners.mockResolvedValue([{ processIdentity: identity }]);
  await reader.enrich(rows);
  expect(rows[0].lastFileUpdatedAt).toBeUndefined();
  reader.close();
  await reader.enrich(rows);
  expect(readOwners).toHaveBeenCalledTimes(3);
});

test("discovery publishes only the edit provider timestamp and closes it on shutdown", async () => {
  const enrich = jest.fn(async (rows: CodexInstance[]) => { rows[0].lastFileUpdatedAt = base + 2000; });
  const close = jest.fn();
  const startedAt = new Date(base).toISOString();
  const discovery = new CodexDiscovery({ listProcesses: async () => [
    { pid: 1, parentPid: 0, name: "Code.exe", startedAt, executablePath: process.execPath },
    { pid: 42, parentPid: 1, name: "codex.exe", startedAt },
  ] }, { enrich, close });
  const status = jest.spyOn(discovery as any, "status").mockResolvedValue("");
  try { expect((await discovery.scan()).instances[0]).toMatchObject({ codexPid: 42, lastFileUpdatedAt: base + 2000 }); }
  finally { discovery.close(); status.mockRestore(); }
  expect(enrich).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
});

const windowsTest = process.platform === "win32" ? test : test.skip;
windowsTest("native reader handles absent databases without creating or changing them", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tray-codex-edits-native-"));
  const reader = new CodexFileUpdates({ codexHome: home, helperPath: path.join(__dirname, "resources", "codex-file-updates.ps1") });
  try {
    const rows = [instance()];
    await reader.enrich(rows);
    expect(rows[0].lastFileUpdatedAt).toBeUndefined();
    expect(await fs.readdir(home)).toEqual([]);
  } finally { reader.close(); }
}, 15000);

windowsTest("native SQLite query links edit history to a process without modifying the databases", async () => {
  const { home, file, reader: unused } = await fixture();
  unused.close();
  const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'";
  const databases = [
    { file: path.join(home, "logs_2.sqlite"), sql: "CREATE TABLE logs (process_uuid TEXT, thread_id TEXT, ts INTEGER, ts_nanos INTEGER, feedback_log_body TEXT); " +
      `INSERT INTO logs VALUES (${quote(identity)}, ${quote(threadId)}, ${base / 1000 + 1}, 0, ${quote("run_sampling_request{turn_id=" + turnId + " model=test}")});` },
    { file: path.join(home, "state_5.sqlite"), sql: "CREATE TABLE threads (id TEXT, rollout_path TEXT); " +
      `INSERT INTO threads VALUES (${quote(threadId)}, ${quote(file)});` },
  ];
  // Test-only database creation; the production helper opens both files read-only.
  const seed = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CodexFixtureSqlite {
  [DllImport("winsqlite3.dll", CallingConvention=CallingConvention.Cdecl)] static extern int sqlite3_open_v2(byte[] file, out IntPtr db, int flags, IntPtr vfs);
  [DllImport("winsqlite3.dll", CallingConvention=CallingConvention.Cdecl)] static extern int sqlite3_exec(IntPtr db, byte[] sql, IntPtr callback, IntPtr state, IntPtr error);
  [DllImport("winsqlite3.dll", CallingConvention=CallingConvention.Cdecl)] static extern int sqlite3_close(IntPtr db);
  public static void Create(string file, string sql) {
    IntPtr db;
    if (sqlite3_open_v2(Encoding.UTF8.GetBytes(file + "\\0"), out db, 6, IntPtr.Zero) != 0) throw new Exception("Fixture open failed");
    try { if (sqlite3_exec(db, Encoding.UTF8.GetBytes(sql + "\\0"), IntPtr.Zero, IntPtr.Zero, IntPtr.Zero) != 0) throw new Exception("Fixture SQL failed"); }
    finally { sqlite3_close(db); }
  }
}
'@
$fixtures = [Console]::In.ReadToEnd() | ConvertFrom-Json
foreach ($fixture in $fixtures) { [CodexFixtureSqlite]::Create($fixture.file, $fixture.sql) }
`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", seed],
    { input: JSON.stringify(databases), windowsHide: true, timeout: 10000 });
  const before = await Promise.all(databases.map(db => fs.readFile(db.file)));
  const reader = new CodexFileUpdates({ codexHome: home, now: () => base + 10000,
    helperPath: path.join(__dirname, "resources", "codex-file-updates.ps1") });
  try {
    const rows = [instance(), instance(43)];
    await reader.enrich(rows);
    expect(rows.map(row => row.lastFileUpdatedAt)).toEqual([base + 2000, undefined]);
    expect(await Promise.all(databases.map(db => fs.readFile(db.file)))).toEqual(before);
  } finally { reader.close(); }
}, 20000);
