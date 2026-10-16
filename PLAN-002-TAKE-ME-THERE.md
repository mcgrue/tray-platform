# Take me there

## Goal

A global shortcut returns the human to work awaiting attention. Depends on Plan 001.

## Implementation

- Register a configurable Electron global shortcut, default Ctrl+Alt+Space, after app readiness. Persist settings, surface registration conflicts, provide a tray fallback, and unregister on exit.
- One pending item activates its destination, or shows its details if no destination exists. Several pending items open a compact chooser, newest first, with title/source filtering, arrows, Enter, and Escape. Zero items opens the empty inbox.
- Exclude Snoozed and Done items; revalidate the selected item before activation. Reuse Plan 001 destination handling and the existing application window. Repeated presses must not create duplicate windows or listeners.
- Activation is explicit and does not mark Done. Display activation failures without losing the pending item.

## Acceptance

Add tests for zero/one/multiple items, excluded states, ordering, disappearing items, filtering/keyboard selection, and registration conflicts. Verify the shortcut from another app, minimized destinations, cancellation, and repeated presses on Windows. Run new tests, existing Jest suite, and build; leave existing tests unchanged.

# HUMAN QUESTIONS

- Resolved: desktop windows and links suffice for v1; exact browser tabs are deferred.
- Defaults: Ctrl+Alt+Space, newest first, chooser whenever several items are pending.
