# Codex question hook verification

Verified 2026-10-20. Both question tools support notification hooks in the installed VS Code runtime.

## Test boundary

- Extension: `openai.chatgpt-26.1007.21434-win32-x64`.
- Executable: that extension's `bin/windows-x86_64/codex.exe`, version `0.162.0-alpha.17.2`.
- Used the real app-server over stdio with a local HTTP fixture providing deterministic Responses events. No model inference or API credentials were used.
- Each case used an independent temporary `CODEX_HOME` and workspace. Hook definitions were discovered with `hooks/list`, checked against the exact local recorder command, and trusted through `config/value/write`. No hook-trust bypass was used.
- Tested exact matcher: `^request_user_input(_async)?$`. A separate successful `SessionStart` hook provided a positive control.
- Global `config.toml`, `hooks.json`, `codex-notify.ps1`, and `notify.json` hashes were unchanged. No application code, existing tests, or live inbox entries were changed.

## Results

| Case | Before question delivery | After tool invocation | Verdict |
| --- | --- | --- | --- |
| `request_user_input`, Plan mode | `PreToolUse` ran successfully | Stayed pending with no post-hook until the fixture client answered; then `PostToolUse` included that answer | PASS |
| `request_user_input_async`, Default mode | `PreToolUse` ran successfully | `PostToolUse` returned immediately with `{"accepted":true}`; the client sent no answer | PASS |

Both hook payloads contain `session_id`, `turn_id`, `cwd`, `tool_use_id`, `tool_name`, and `tool_input.questions`, including options.

Blocking event order, UTC:

1. `22:40:30.718`: pre-hook completed.
2. `22:40:30.719`: app-server emitted `item/tool/requestUserInput` with `isBlocking: true`.
3. `22:40:31.761`: fixture client answered `Alpha`.
4. `22:40:32.082`: post-hook completed, with the answer in `tool_response`.

Async event order, UTC:

1. `22:40:30.720`: pre-hook completed.
2. `22:40:30.721`: app-server emitted an `agentMessage` item with `delivery: "async"` and structured questions.
3. `22:40:30.961`: post-hook completed. No answer was submitted.

Therefore, use `PreToolUse` to create an attention request for either tool. Do not treat async `PostToolUse` as resolution.

## Evidence and rerun

Retained diagnostic directory (temporary storage):

`C:\Users\benmc\AppData\Local\Temp\tray-codex-hooks-a837ad1915e74ffb906410f780ef3232`

- Harness: `probe.cjs`; hook recorder: `record-hook.cjs`.
- Blocking PASS: `run-ggUwGM/result.json`, `hook-events.jsonl`, `while-waiting.json`, and `protocol.jsonl`.
- Async PASS: `run-Bo739T/result.json`, `hook-events.jsonl`, and `protocol.jsonl`.
- Rerun from that directory: `node probe.cjs` and `node probe.cjs request_user_input_async`. Both successful runs exited 0 with assertions passing.

Earlier diagnostic runs remain in the directory. The first exposed Windows command quoting in the recorder and was corrected; it is not a passing result.

The initial probe verified the runtime protocol and executable hooks. The implementation checks below now cover HTTP delivery and tray rendering as well.

## Installed bridge acceptance (2026-10-20)

- `yarn test --runInBand`: 15 suites, 96 tests passed (11 new bridge/installer tests). Existing tests were not modified.
- `yarn pre-build`: passed.
- `yarn electron dev-infrastructure/smoke-codex.cjs`: passed using the installed extension's Codex executable. Two independent runtimes used the installer's exact background hook configuration and delivered into an isolated Electron process. Both questions rendered, each requested one sound, replay did not duplicate items or sound, manual Done persisted, and the window stayed hidden.
- Final isolated Electron data: `C:\Users\benmc\AppData\Local\Temp\tray-codex-electron-VuwkNe`; runtime evidence: `tray-codex-fixture-2iczsH` and `tray-codex-fixture-0b1Cq6` under the same Temp directory.
- Live delivery to port 22222 passed for both question types. Replaying through the installed bridge also passed. The two explicitly labelled test entries were marked Done and retained in history. Evidence: `live-result.json` in the initial diagnostic directory; runtime fixture directories `tray-codex-fixture-108CWq` and `tray-codex-fixture-oZwO8t`.
- Global hook installed in `C:\Users\benmc\.codex\hooks.json`, with trusted status confirmed through `hooks/list`. Bridge installed in `C:\Users\benmc\.codex\tray-platform\attention-hook.cjs`. Installation metadata and the config backup path are in that directory's `installation.json`.
- Existing hooks and their trust metadata were preserved. The installer retained backups of overwritten files.

At initial acceptance, automatic approval review rejected the live process restart with “blocked by policy.” The process was subsequently restarted: the follow-up observed the repository's Electron executable listening on port 22222 with a start time of 2026-10-20 16:40 PDT. Reopen existing Codex sessions as needed to load the global hook.

Actual question rendering inside two VS Code windows still needs manual acceptance. The computer-use guidance says, “Do not automate the ChatGPT desktop app UI or Codex CLI or Codex extensions within Windows apps.” The substitute automated checks use the exact extension-bundled runtime and real tray renderer, with deterministic local responses.

## Pre-commit verification refresh (2026-10-20)

- `yarn test --runInBand`: all 15 suites and 96 tests passed.
- `yarn pre-build`: passed.
- `yarn electron dev-infrastructure/smoke-codex.cjs`: passed again with the installed VS Code runtime, isolated tray data, and two independent Codex sessions. Verified rendered questions, distinct identities, one sound request each, retry deduplication, manual Done, and no focus change.
- Retained evidence: `tray-codex-electron-vhAmww`, `tray-codex-fixture-DyQfgG`, and `tray-codex-fixture-ULm90v` under the local Temp directory.
- A real `request_user_input_async` call from the current VS Code conversation created a pending item in the live inbox with the correct `D:\dev\grue\tray-platform` project. This verifies the installed user-level hook from this session; another VS Code window and human visual acceptance remain outstanding.
- The global `AGENTS.md` guidance was appended with a verified backup and preserved original content. The current conversation received that updated guidance.

## Answer dismissal and existing sessions (2026-10-20)

- The second Breaditor test remained pending after its recorded async reply. The installed bridge matched the repository, and the reply's session, call, index, and question hash matched the stored request. No answer marker had been written. That conversation started before the answer hooks were installed.
- An isolated experiment with the installed runtime reproduced the lifecycle issue: start a session with only `PreToolUse`, then add already-trusted answer hooks on disk. Creation works, but the answer hook never records receipt and the item stays pending. Starting a session with all three hooks loaded dismisses the item. Evidence: `tray-codex-fixture-nJSGYX` (existing session) and `tray-codex-fixture-iGuVtz` (fresh session) under the local Temp directory. The experiment adapted the fixture in memory; existing test files were not changed.
- Replayed only the recorded Breaditor reply through the installed bridge's answer handler. The exact item `question-36d0ca9bb63364e6d4356cb6a6222ee8bc0104a80241707ce6d805acde53a901` became Done; the live API now reports no pending items. This is recovery of the missed reply, not evidence that the old session reloaded its hooks.
- README and installer output now explicitly require reloading existing VS Code windows or restarting CLI sessions after adding hooks. The live Breaditor window was not restarted; its next real answer still needs verification after reload.
- Validation: 16 suites / 108 tests passed; `yarn pre-build` passed; the existing Codex-to-Electron smoke passed for blocking answers and async replies both during and after a turn, including removal from the pending view and persisted Done history. Evidence: `tray-codex-electron-mSJ0AS`, `tray-codex-fixture-sCsxb1`, `tray-codex-fixture-54eTNR`, and `tray-codex-fixture-JcQHBA` under the local Temp directory.
