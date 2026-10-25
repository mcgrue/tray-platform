# Persistent attention inbox

## Goal

Persist explicit requests for attention so a missed sound does not lose the task.

## Implementation

- Add a main-process attention service backed by a versioned JSON store in Electron's userData directory. Serialize mutations and atomically replace the store before acknowledging, emitting changes, or playing sounds. Failed writes must not poison the queue. Preserve corrupt/unsupported stores and report a read-only error. Enforce a single application instance.
- Items have caller-provided source/id, title, optional description/project/destination/sound ID, timestamps, and pending/done state. PUT /api/attention/:source/:id creates or updates idempotently; GET /api/attention lists items. Updates preserve disposition and do not sound again; a new attention request uses a new ID.
- Restrict new API routes to loopback callers, handle every response/error, and preserve legacy sound/speech GET behavior and listener binding. Initialize storage before listening. Sound dispatch tolerates an absent/reloading renderer.
- Add Pending and Done views to the existing window, newest first, and a pending count in the tray tooltip. Keep existing audio elements mounted. Provide Go, Done, and explicit Reopen. Go never marks Done.
- Restore saved items on startup without replaying historical sounds. Retain Done history. Legacy deferred items become Pending during the version 2 store migration.
- Go opens HTTP(S) links or activates a selected window. A hidden PowerShell helper under src/main/resources exchanges JSON with bounded timeouts. Window identity includes HWND, PID, and process start time; validate again before activation. Exclude this application's windows. Missing/stale/refused destinations stay pending with an error.
- Provide window discovery for robots and a UI picker. Use narrow typed preload methods, unsubscribe callbacks, and main-owned state.

## Acceptance

Add new tests for idempotence, state transitions, concurrent mutations, migration/restart recovery, failed-write recovery, malformed stores, API errors, loopback checks, and legacy compatibility. Verify Windows activation/minimized/stale windows and URL opening on the desktop. Receiving an event must never change focus. Run Jest and the build; do not modify existing tests without approval.

Removal verification (2026-10-25): 513 tests across 62 suites, build, focused strict
TypeScript, and desktop/PWA inbox and approval smoke checks passed. Existing test
updates were approved. Legacy migration retains metadata and timestamps, drops
obsolete scheduling fields, creates no timers, and preserves the original file if
the atomic replacement fails. Obsolete state API requests are rejected.

The native presentation smoke reached minimize/restore but Electron returned empty
captures even after a bounded wait; that screenshot assertion remains failing.
Earlier native titlebar/tray phases passed. Desktop/PWA inbox layout and Done/Reopen
checks passed separately. The running user instance was not restarted.

# HUMAN QUESTIONS

- Resolved: only explicit structured events enter the inbox; legacy sound calls retain their behavior.
- Resolved: support windows and HTTP(S) links; exact browser-tab selection is deferred.
- Defaults: Go does not acknowledge completion; Done history is retained; no automatic repeated reminders.
