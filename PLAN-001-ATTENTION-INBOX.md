# Persistent attention inbox

## Goal

Persist explicit requests for attention so a missed sound does not lose the task.

## Implementation

- Add a main-process attention service backed by a versioned JSON store in Electron's userData directory. Serialize mutations and atomically replace the store before acknowledging, emitting changes, or playing sounds. Failed writes must not poison the queue. Preserve corrupt/unsupported stores and report a read-only error. Enforce a single application instance.
- Items have caller-provided source/id, title, optional description/project/destination/sound ID, timestamps, and pending/snoozed/done state. PUT /api/attention/:source/:id creates or updates idempotently; GET /api/attention lists items. Updates preserve disposition and do not sound again; a new attention request uses a new ID.
- Restrict new API routes to loopback callers, handle every response/error, and preserve legacy sound/speech GET behavior and listener binding. Initialize storage before listening. Sound dispatch tolerates an absent/reloading renderer.
- Add Pending, Snoozed, and Done views to the existing window, newest first, and a pending count in the tray tooltip. Keep existing audio elements mounted. Provide Go, Snooze (5/15/60 minutes), Done, and explicit Reopen. Go never marks Done.
- Snooze expiry returns an item to Pending and cues once. Restore overdue items on startup without replaying historical sounds. Retain Done history.
- Go opens HTTP(S) links or activates a selected window. A hidden PowerShell helper under src/main/resources exchanges JSON with bounded timeouts. Window identity includes HWND, PID, and process start time; validate again before activation. Exclude this application's windows. Missing/stale/refused destinations stay pending with an error.
- Provide window discovery for robots and a UI picker. Use narrow typed preload methods, unsubscribe callbacks, and main-owned state.

## Acceptance

Add new tests for idempotence, state transitions, concurrent mutations, snooze/restart recovery, failed-write recovery, malformed stores, API errors, loopback checks, and legacy compatibility. Verify Windows activation/minimized/stale windows and URL opening on the desktop. Receiving an event must never change focus. Run Jest and the build; do not modify existing tests without approval.

# HUMAN QUESTIONS

- Resolved: only explicit structured events enter the inbox; legacy sound calls retain their behavior.
- Resolved: support windows and HTTP(S) links; exact browser-tab selection is deferred.
- Defaults: Go does not acknowledge completion; Done history is retained; no automatic repeated reminders.
