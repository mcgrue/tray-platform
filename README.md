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
