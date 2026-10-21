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

Run `yarn start` (or `yarn dev` for the existing watch workflow). The tray menu
opens the inbox. Pending items support Go, Snooze, and Done; history supports
Reopen. Closing the window keeps the tray process running; use its Quit command
to exit. Data is stored in `attention.json` in Electron's user-data directory.

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

   This copies the standalone bridge into `~/.codex/tray-platform/` and adds
   one background `PreToolUse` hook to `~/.codex/hooks.json`. It preserves other
   hooks and backs up files before replacing them. Re-running it updates the
   bridge without adding a duplicate hook. The installer does not modify
   `AGENTS.md` or grant hook trust.

2. Open `/hooks` in the Codex CLI using that same profile. Review and trust the
   Tray Platform `PreToolUse` command whose matcher is
   `^request_user_input(_async)?$`. Confirm it is enabled and trusted. New or
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
   reopen Codex sessions or start fresh sessions in each client so they load the
   hook and global guidance. File edits do not inject instructions into an
   already-running turn. Confirm a fresh session can summarize the new rule.

5. In a scratch conversation, ask the agent to pose a choice using an available
   structured question tool. Confirm one inbox entry with the correct question
   and project, and one ICQ sound. Repeat from another repository/client to
   verify user-level coverage. If no question tool is available, the instruction
   alone cannot enable it; use a runtime/mode that exposes one.

Separate `CODEX_HOME` profiles and other OS users need their own installation.
WSL, containers, and remote agents also need configuration and connectivity
appropriate to their environment; their loopback address may not reach the
Windows tray process.

See the official [global instruction discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
and [hook configuration and trust](https://learn.chatgpt.com/docs/hooks) documentation.

### Behavior and maintenance

Both `request_user_input` and `request_user_input_async` create an inbox entry
with the question, choices, project directory, and session/turn/call identifiers.
Each new question plays one ICQ sound. Repeated delivery preserves the existing
entry. Mark **Done** manually; answering in Codex does not clear it. Use the
existing destination picker to associate a window; automatic navigation back
to the originating conversation is not part of this bridge.

Keep tray-platform running on the same machine. The default endpoint is
`http://127.0.0.1:22222`; `TRAY_PLATFORM_ATTENTION_URL` can select another HTTP
loopback origin/port. Remote hosts and redirects are not used. Failed delivery
is logged to hook stderr, exits successfully, and is not queued for later.
Ordinary questions written in chat, turn completions, and permission-approval
prompts do not create entries through this bridge. Existing completion sounds
and permission-approval hooks remain independent.

After updating tray-platform, quit and reopen it to load API changes. Disable
the Tray Platform hook in `/hooks` to stop question notifications.

Validation: `yarn test --runInBand` and `yarn pre-build`. For the complete
runtime-to-renderer smoke, set `CODEX_CLI` to the VS Code extension's bundled
`codex.exe`, clear `ELECTRON_RUN_AS_NODE`, then run
`yarn electron dev-infrastructure/smoke-codex.cjs`. It uses two real app-server
processes with deterministic local response fixtures, isolated Codex homes and
Electron data, and checks rendering, deduplication, sound requests, and Done.

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
