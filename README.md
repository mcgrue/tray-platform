# electron-from-scratch

Screw boilerplates, let's do this piece by piece!

[![Our Tests](https://github.com/mcgrue/electron-from-scratch/actions/workflows/test.yml/badge.svg)](https://github.com/mcgrue/electron-from-scratch/actions/workflows/test.yml)

/dist/ is for US to make artifacts to (via esbuild) /build/ is for
ELECTRONBUILDER to take /dist/ and repackage

## TODO

- esbuild -> (dont minifify, do output sourcemaps: gives you code coverage!)
- nyc (code coverage)
- jest

- implement packaage.json's scripts.build-types

* Currently, src/main/index.ts is the only "hardpoint" for the node server code,
  as defined in build-infrastructre/esbuild.js 's `entryPoints`

## Attention inbox

Titlebar colors are loaded from `.env` at startup (see `.env.example`):

```dotenv
TRAY_PLATFORM_TITLEBAR_ACTIVE_COLOR="#344768"
TRAY_PLATFORM_TITLEBAR_INACTIVE_COLOR="#232c3b"
TRAY_PLATFORM_TITLEBAR_ACTIVE_TEXT_COLOR=""
TRAY_PLATFORM_TITLEBAR_INACTIVE_TEXT_COLOR=""
```

Use quoted `#RRGGBB` colors. The optional text colors apply to title text and
Windows/Linux window-control symbols. Leave either text color blank or unset to
choose black or white for contrast in that state; macOS retains its traffic lights.
Restart the app after changing these values. Smoke scripts set
`TRAY_PLATFORM_SMOKETEST=1`, overriding both idle backgrounds to army olive `#4b5320`
and both text colors to white. Window titles get the `smoketest - ` prefix,
including after renderer reloads.
After building, `yarn electron dev-infrastructure/smoke-titlebar.cjs` checks
color overrides, focus-event updates, title changes, reloads, and close-to-tray.

Run `yarn start` (or `yarn dev` for the existing watch workflow). The attention
inbox opens on startup. Minimizing keeps it in the taskbar for normal restoration
and focus. Double-click the tray icon to open or focus it, or use the tray menu.
Pending items support Go, Snooze, and Done; history supports
Reopen. Closing the window keeps the tray process running; use its Quit command
to exit. Data is stored in `attention.json` in Electron's user-data directory.

While any inbox items are pending, the titlebar cycles amber, purple, and teal
once per second and the tray icon alternates its normal and alert images.
This continues when the window is focused, hidden, minimized, or reloaded, and
starts for saved pending items when the app launches. Windows/Linux additionally
request taskbar attention while unfocused; macOS uses a critical Dock bounce
while unfocused and resumes it when focus leaves. Resolving or snoozing the last
pending item stops the signal and restores the configured titlebar and tray icon.

New pending work still opens a hidden or minimized inbox on its Pending view
without taking keyboard focus. Duplicate deliveries, metadata edits, and startup
restoration do not reopen the inbox. Explicit tray/menu/shortcut actions focus it.
After updating, quit and relaunch Tray Platform to load the new window behavior.

Windows presentation check: `yarn pre-build`, then clear `ELECTRON_RUN_AS_NODE`
and run `yarn electron dev-infrastructure/smoke-attention-presentation.cjs`.
It checks cycling titlebar/native overlay colors, persistent tray-image changes,
hidden/minimized opening, restoration after clearing pending items, and unchanged
OS foreground with zero inbox focus events. macOS Dock calls have unit coverage;
native bounce acceptance must be run on macOS.

Robots can explicitly submit an attention item from this desktop:

```powershell
$item = @{
  title = 'Build finished'
  description = 'Next: inspect the inventory repro'
  project = 'dredmor'
  sound = 'fanfare'
  destination = @{ kind = 'url'; url = 'https://example.com/build/123' }
} | ConvertTo-Json -Depth 4
Invoke-RestMethod 'http://localhost:22222/api/attention/build/run-123' -Method Put -ContentType 'application/json' -Body $item
```

The source/id pair deduplicates retries. Updating it preserves Done/Snoozed
state and does not replay sound; use a new ID for a new request. Sound values
are IDs in `src/shared/sounds.json`, such as `fanfare`, `fail`, and `icq`.

- `GET /api/attention`: `{ items, error? }` snapshot.
- `PUT /api/attention/:source/:id`: create/update; returns `{ item }`.
- `POST /api/attention/:source/:id/state`: `{ state, minutes? }`; snooze accepts 5, 15, or 60 minutes.
- `GET /api/windows`: `{ windows }`; copy a complete window descriptor into an item's `destination`.

New API routes accept loopback callers without a browser Origin header. Existing
sound/speech GET endpoints continue working and do not create inbox entries.
Go opens HTTP(S) links or activates a chosen Windows window without completing
the item. Closed/replaced windows must be selected again.

For create-only delivery, send `If-None-Match: *` with the attention PUT. An
existing source/id returns HTTP 412 without changing the entry, its timestamp,
its selected destination, or its disposition. Ordinary PUT updates keep their
existing behavior.

## Codex question notifications

### Install for your user

Install once for each Codex user profile. CLI and VS Code sessions using the
same Codex home share this setup across repositories. The default home is
`~/.codex` (`%USERPROFILE%\.codex` on Windows); if `CODEX_HOME` is set, use that
directory for every path below and run the installer with the same setting.

1. With Node.js installed, run this from the tray-platform repository root:

   ```powershell
   node integrations/codex/install.cjs
   ```

   This copies the bridge and its answer-correlation module into
   `~/.codex/tray-platform/` and adds three background hooks to
   `~/.codex/hooks.json`: `PreToolUse`, `PostToolUse`, and `UserPromptSubmit`. It preserves other
   hooks and backs up files before replacing them. Re-running it updates the
   bridge and adds missing answer hooks without duplicating existing hooks. The installer does not modify
   `AGENTS.md` or grant hook trust.

2. Open `/hooks` in the Codex CLI using that same profile. Review and trust the
   Tray Platform commands: `PreToolUse` with matcher
   `^request_user_input(_async)?$`, `PostToolUse` with matcher
   `^request_user_input$`, and `UserPromptSubmit` without a matcher.
   Confirm all three are enabled and trusted. New or
   changed hook definitions require review before they can run.

3. Back up your existing `~/.codex/AGENTS.md`, then append the following section
   while preserving its current instructions. If a non-empty
   `~/.codex/AGENTS.override.md` already exists, update that active file instead;
   it takes precedence over `AGENTS.md`. Do not create an override just for
   this installation.

   ```markdown
   ## Questions requiring human input

   - When you need a human decision, clarification, or missing information, use an available structured question tool, subject to its documented restrictions and the current session's instructions.
   - Use request_user_input_async when available for questions during ongoing work. Use request_user_input when available and permitted by the current mode.
   - Include enough project/task context in the question to identify the work from an attention notification.
   - The user-level Tray Platform hook handles notification delivery for these tool calls. Do not also send a separate notification for the same question.
   - Ask only when the answer is needed. Continue independent work while an asynchronous answer is pending.
   - If neither question tool is available, ask in chat and note that the question was not submitted through the attention hook.
   ```

4. Keep tray-platform running on the same machine. After active work finishes,
   run **Developer: Reload Window** in each existing VS Code window, or restart
   the Codex CLI, then resume the conversation. Existing Codex sessions retain
   their loaded hook configuration: installing the answer hooks on disk does
   not enable dismissal in those sessions, even on later turns. A newly started
   session loads the new hooks. Reload after installing and trusting new hook
   definitions; bridge-only script updates do not require this. Confirm a fresh
   session can summarize the global question rule.

5. In a scratch conversation, ask the agent to pose a choice using an available
   structured question tool. Confirm one inbox entry with the correct question
   and project, and one ICQ sound. Answer every question in the request and
   confirm its entry moves to **Done**. Repeat from another repository/client to
   verify user-level coverage. If no question tool is available, the instruction
   alone cannot enable it; use a runtime/mode that exposes one.

Separate `CODEX_HOME` profiles and other OS users need their own installation.
WSL, containers, and remote agents also need configuration and connectivity
appropriate to their environment; their loopback address may not reach the
Windows tray process.

See the official [global instruction discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
and [hook configuration and trust](https://learn.chatgpt.com/docs/hooks) documentation.

### Behavior and maintenance

On Windows, expand **Message Codex** on a Codex attention item, type a message,
and click **Send message** or press **Ctrl+Enter**. It targets that item's
conversation, steers an active turn, or starts a follow-up when idle. Sending a
free-form message leaves the item pending; use **Done** when resolved. This is
separate from submitting a structured question answer in Codex.

For async questions, expand **Answer question**, choose a suggested answer or
type your own for each open question, then click **Send answer(s)** (Ctrl+Enter).
Tray sends the extension's structured question reply so Codex can dismiss the
matching question dialog, then marks the Tray item Done after acknowledgment.
The exact original questions are loaded from the matching local session under
`CODEX_HOME/sessions` (default `~/.codex/sessions`), including older inbox items.
Missing transcripts or unverifiable question identities fail visibly. Blocking
questions must still be answered in Codex. **Message Codex** remains free-form.

Failed sends retain the draft. If delivery cannot be confirmed, check the
conversation before resending. The conversation must be open in a Codex client
supporting local owner routing (verified against Windows VS Code extension
`26.1007.21434`). This uses an internal versioned IPC protocol; incompatible
clients fail visibly. Standalone CLI, WSL, and remote sessions are not supported.
Existing hook items work without reinstalling the bridge when their original
session header is intact. Updated hooks store a dedicated session ID as well.

Message smoke (isolated Electron profile, fixture IPC router, actual Codex
runtime with deterministic local responses): set `CODEX_CLI` to the extension's
`codex.exe`, run `yarn pre-build`, clear `ELECTRON_RUN_AS_NODE`, then run
`yarn electron dev-infrastructure/smoke-codex-messages.cjs`.

Both `request_user_input` and `request_user_input_async` create an inbox entry
with the question, choices, project directory, and session/turn/call identifiers.
Each new request plays one ICQ sound. Repeated delivery preserves the existing
entry. Answering every question in a request automatically moves its entry to
**Done**, preserving its history, title, and destination. Partial answers keep
the request pending. You can still mark **Done** manually.

On Windows, new questions identify their originating Codex and VS Code processes.
**Go** (including the pending-work chooser and shortcut) refreshes the process
inventory and focuses that editor window. It does not select a particular Codex
conversation within the window. The card shows the originating window title and
process IDs. An explicitly chosen window or link overrides automatic navigation.
Closed/restarted processes, unavailable titles, and ambiguous identical window
titles require retrying or using **Choose destination**; folder names are never
used to guess a window. Existing items without origin metadata keep the manual
destination picker.

Run `node integrations/codex/install.cjs` after updating the bridge, then quit and
relaunch Tray Platform after building. The hook definitions are unchanged, so this
bridge-only update does not require restarting Codex sessions. Origin capture is
optional: failed discovery still delivers the question. The Windows delivery
deadline is 3.5 seconds, within the installed background hook's 5-second timeout.

Validation: `yarn test --runInBand`, `yarn pre-build`, then (from a local VS Code
Codex session, with `ELECTRON_RUN_AS_NODE` unset):
`node node_modules/electron/cli.js dev-infrastructure/smoke-codex-origin.cjs`.
The isolated smoke sends a real hook payload, clicks Go with native mouse input,
verifies the foreground HWND, checks stale-origin errors, and retains a report
and screenshot under the system temporary directory. It briefly focuses the
originating editor and attempts to restore the previous foreground window.

Blocking answers are detected by `PostToolUse`. Async answers are detected by
`UserPromptSubmit` when the client submits a structured
`send_user_message_question_reply` envelope, during an active turn or in a later
turn. The immediate async tool result (`accepted: true`) does not dismiss anything.
During an active turn, dismissal follows Codex consuming the reply at its next
input-processing boundary.
Ordinary chat text is not treated as an answer. Matching uses the session, original
call, question index, and a hash of the question; unrelated entries stay pending.
Repeated answer delivery preserves an entry you manually reopened after dismissal.

Correlation metadata lives in `~/.codex/tray-platform/question-state/`. It stores
identifiers and question hashes, without question or answer text. Keep it across
updates so replies can match earlier requests. Entries created before installing
the answer hooks lack this metadata and may still need manual **Done**.

Keep tray-platform running on the same machine. The default endpoint is
`http://127.0.0.1:22222`; `TRAY_PLATFORM_ATTENTION_URL` can select another HTTP
loopback origin/port. Remote hosts and redirects are not used. Failed delivery
is logged to hook stderr and exits successfully. There is no background retry
worker. Answer markers persist, so re-delivering the matching question or answer
can complete a failed dismissal. Hooks tolerate answers racing question creation.
Ordinary questions written in chat, turn completions, and permission-approval
prompts do not create entries through this bridge. Existing completion sounds
and permission-approval hooks remain independent.

After updating tray-platform, quit and reopen it to load API changes. Disable
the three Tray Platform hooks in `/hooks` to stop question notifications and
automatic dismissal. After bridge-only updates, rerun the installer; no tray
restart is needed.

Validation: `yarn test --runInBand` and `yarn pre-build`. For the complete
runtime-to-renderer smoke, set `CODEX_CLI` to the VS Code extension's bundled
`codex.exe`, clear `ELECTRON_RUN_AS_NODE`, then run
`yarn electron dev-infrastructure/smoke-codex.cjs`. It uses three real app-server
processes with deterministic local response fixtures, isolated Codex homes and
Electron data, and checks rendering, deduplication, sound requests, blocking
answers, partial async answers, async replies during/after a turn, and persisted Done history.

Validation: `yarn test --runInBand`, `yarn pre-build`, then
`yarn electron dev-infrastructure/smoke-inbox.cjs` for isolated Electron/Windows
acceptance. Clear `ELECTRON_RUN_AS_NODE` if it is set. Smoke data stays in a
separate temporary user-data directory; the live inbox is not used.

## Take me there

Press `Ctrl+Alt+Space`, or choose **Take me there** in the tray menu. One pending
item opens its destination; several show a chooser. Filter by title/source,
use arrows to select, Enter to go, and Escape to close. Snoozed and Done items
are excluded. Going to work keeps it pending until you explicitly mark Done.

Change the binding under **Keyboard shortcuts** in the application. Requested
bindings persist in `shortcuts.json`; registration conflicts are shown there,
and the tray/menu button remains available. Validate with
`yarn electron dev-infrastructure/smoke-navigation.cjs` after building.

## Context bookmarks

Press `Ctrl+Alt+B` to capture the foreground window before the editor opens.
Choose an attention item or enter a project, then write the next action. The
capture shortcut is configurable alongside the navigation shortcut. Capture
failures still allow a note without a destination. **Resume note** on an inbox
item edits its context; **Context bookmarks** also supports standalone project
notes, project filtering, Edit, and Go.

Robots use `GET /api/bookmarks` and `PUT /api/bookmarks/:source/:id`. Creation
requires a title and either `project` or `attention: { source, id }`; optional
fields include `destination` and `robotHint`. Later PUTs may update individual
fields. Human notes are edited through the UI; robot updates preserve them and
reject `humanNote` in API requests. Human edits preserve robot hints. Completing
an attention item keeps its notes, and the chooser displays its resume context.

Bookmarks persist separately in `bookmarks.json` under the same user-data
directory. Run `yarn electron dev-infrastructure/smoke-bookmarks.cjs` after
building for isolated capture, notes, API, and restart acceptance checks.
