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
