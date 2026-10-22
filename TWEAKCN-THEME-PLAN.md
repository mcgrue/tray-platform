# Tray Platform tweakcn theme

Apply tweakcn's Clean Slate dark preset to the existing Electron renderer.

## Implementation

- `src/app/tweakcn.css` contains the official theme tokens, with sRGB fallbacks
  for Electron 19 and the original OKLCH values for newer renderers.
- `src/app/app.css` maps the tokens onto the existing cards, tabs, buttons,
  question/message forms, bookmarks, navigation chooser, and process table.
- The renderer imports the CSS; esbuild emits `dist/app/index.css`, which the
  HTML loads locally. Fonts use local Inter/JetBrains Mono when installed,
  falling back to Segoe UI/system fonts and Consolas. No runtime downloads.
- Native titlebar state colors still come from the existing titlebar bridge.
- Narrow windows keep process-table scrolling inside its container.
- Sections use a persistent tab bar: Attention Inbox (first and selected on
  startup), Codex Instances, Context Bookmarks, and Sound Board.
  `src/app/section-tabs.ts` keeps panels mounted so drafts, filters, sorting,
  and scroll positions survive tab switches. Arrow keys, Home, and End select
  tabs. Attention/navigation and bookmark-capture events reveal their tab
  before the existing UI handler focuses or scrolls its controls.

Source: [tweakcn registry, Clean Slate](https://github.com/jnsahaj/tweakcn/blob/a3b47b37cba97dd637de517aab52c45ec0f83456/public/r/registry.json),
commit `a3b47b37cba97dd637de517aab52c45ec0f83456`.
The upstream Apache-2.0 license is retained in
`src/app/resources/TWEAKCN-LICENSE.txt` and copied into the build.

To change the palette, update `tweakcn.css`; keep the sRGB fallbacks in sync
with the OKLCH tokens while Electron 19 is supported. Component styling lives
in `app.css`. No React or Tailwind runtime is required for these CSS tokens.

## Verification

```powershell
yarn pre-build
yarn test --runInBand
$env:ELECTRON_RUN_AS_NODE = $null
& .\node_modules\.bin\electron.cmd dev-infrastructure/smoke-tweakcn-theme.cjs
& .\node_modules\.bin\electron.cmd dev-infrastructure/smoke-inbox.cjs
& .\node_modules\.bin\electron.cmd dev-infrastructure/smoke-titlebar.cjs
& .\node_modules\.bin\electron.cmd dev-infrastructure/smoke-codex-instance-table.cjs
```

The theme smoke loads the actual built renderer and CSS using an isolated
bridge fixture. It checks Electron 19 colors, focus rings, question editing,
hidden controls and cards, bookmark editing, and table overflow at 480px.
It also checks tab order/default selection, keyboard navigation, retained
drafts/filter/sort/scroll, shortcut routing, and narrow tab-bar scrolling.
It retains screenshots in the temporary directory printed on completion.
It does not send messages or modify the live inbox.

Validated on 2026-10-22: build, 263 tests across 34 suites, and the four
Electron smokes above passed. Screenshots reviewed at 920px and 480px.
After the tab conversion, the build, 263 unit tests, updated theme smoke,
and existing inbox smoke passed; tab screenshots were reviewed at both widths.
The existing bookmark smoke passed its UI steps but stopped at its global
capture-shortcut assertion: the default shortcut was unavailable/already held
by another application. That assertion was left unchanged.

To view the theme in the live app, quit Tray Platform from its tray menu and
run `yarn start`; closing its window alone only hides it.

# HUMAN QUESTIONS

None required. Clean Slate dark is the initial preset, matching the existing
dark application. A theme picker is outside this change.
