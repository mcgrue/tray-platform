# Codex instance table sorting and file activity

- Make every column sortable in both directions using keyboard-accessible header
  buttons, visible direction indicators, and `aria-sort`.
- Keep the chosen ordering when discovery refreshes. Sort PIDs and timestamps
  numerically; keep unavailable values last in either direction.
- Add a Last file update column with a readable timestamp and explicit unavailable
  state. Carry the timestamp through the existing discovery snapshot and API.
- Use successful `patch_apply_end` and completed `FileChange` events from Codex
  session history. Attribute each turn through the executing process identity in Codex's local activity log,
  checking the live PID and process creation time. Reject ambiguous ownership.
- Read the local Codex SQLite databases through Windows' built-in SQLite library
  in read-only mode. Bound helper execution, transcript reads and cached history.
  Unknown schema or unavailable history displays Unavailable.
- General shell-script writes are not confirmed edit events and do not advance
  this column. Project file modification times are not used as a fallback.
- Add new tests and an Electron smoke for sorting and file activity. Preserve
  existing tests and unrelated worktree changes.

# HUMAN QUESTIONS

- Answered: most recent file edit made by that Codex instance.

## Validation

- Build passed. The earlier workspace scanner and JSONC dependency were replaced.
- Full suite: 26 suites, 186 tests passed. Final attribution suite: 12 passed,
  including both event formats, process attribution, PID reuse, ambiguous turns,
  malformed/missing history, extended Windows paths, and discovery integration.
- Native SQLite fixture confirmed correct process attribution and byte-for-byte
  unchanged databases after reading.
- Live Electron smoke passed with 14 instances. Four had confirmed edits for
  their current process; others displayed Unavailable. Verified refresh, reload,
  IPC/API consistency and the rendered table, including Dredmor's recorded edit.
- New Electron table smoke verified all five columns in both directions, numeric
  PID/time sorting, missing values, refresh ordering, Enter/Space activation,
  accessible sort state, and disposal. Inspected its screenshot.
- Existing tests and unrelated worktree changes were preserved.
