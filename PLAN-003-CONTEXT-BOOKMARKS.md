# Context bookmarks

## Goal

Preserve the next action for an attention item or project. Depends on Plans 001 and 002.

## Implementation

- Persist task-associated or standalone project bookmarks with title, plain-text human note, separate robot hint, optional destination, association, and timestamps. Robot updates must not overwrite human notes.
- Add a Resume note editor to attention details and a Bookmarks view with project filtering. Show notes/hints beside Go and in the attention chooser. Completing an attention item retains its bookmark.
- Register a configurable capture shortcut, default Ctrl+Alt+B. Capture foreground window identity before showing/focusing application UI, then let the human select a task/project and write a note. If capture fails, allow saving without a destination.
- Expose bookmark create/read/update APIs to robots and typed preload methods to the renderer. Reuse persistence, shortcut settings, and destination activation. Capture is explicit; no project-switch monitoring or scraping window contents.
- Standalone bookmarks can open their destination without generating an attention item. Keep human notes and robot hints separately editable by their intended flows.

## Acceptance

Add tests for task/project association, persistence/restart, edits, separate robot/human text, shortcut registration, capture-before-show ordering, and stale destinations. Verify actual Windows capture/activation and useful resumption notes. Run Jest and build; leave existing tests unchanged.

# HUMAN QUESTIONS

- Resolved: task-associated and standalone project bookmarks; explicit capture.
- Defaults: plain text, manual project selection, Ctrl+Alt+B, no attention events from bookmarks.
