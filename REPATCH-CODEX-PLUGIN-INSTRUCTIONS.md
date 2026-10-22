# Reapply the Codex VS Code question-dismissal patches

Run from this repository in Windows PowerShell. Source of truth:
[integrations/codex/question-dismissal.cjs](integrations/codex/question-dismissal.cjs).

**Verified extension: `openai.chatgpt` version `26.1007.21434`.** Updates may
replace the patched files. The patcher deliberately rejects other versions or
unexpected source. A new version requires the porting procedure below; changing
the version constant alone is insufficient.

## What must be preserved

| Change | Required behavior |
| --- | --- |
| External-answer dismissal | Clear the selected question editor when its questions have accepted answers. Keep unanswered questions and unsent local draft edits. |
| Replies in later turns | Watch later turns of the same conversation, including changes from pending to accepted steering. Feed their replies to the question synchronizer without changing conversation history. |

Both changes are installed by `--follow-ups --apply`. Omitting `--follow-ups`
installs only the original dismissal fix on an unpatched asset.

The cloud admission fix is separate: Tray's
[codex-message-service.ts](src/main/codex-message-service.ts) sends
`useUserMessageAdmission: false` for local owners. It is repository code, not an
extension patch. Keep that behavior when reviewing compatibility after updates.

## Reapply to the verified version

1. Identify the extension directory used by the affected VS Code installation.
   Several versions may coexist; do not select one by directory timestamp alone.
   The standard local installation can be listed with:

   ```powershell
   Get-ChildItem -LiteralPath (Join-Path $env:USERPROFILE '.vscode/extensions') -Directory -Filter 'openai.chatgpt-*' |
     Select-Object -ExpandProperty FullName
   ```

2. Set the path explicitly and inspect its manifest. For the verified installation:

   ```powershell
   Set-Location 'D:/dev/grue/tray-platform'
   $codexExtensionRoot = Join-Path $env:USERPROFILE '.vscode/extensions/openai.chatgpt-26.1007.21434-win32-x64'
   Get-Content -LiteralPath (Join-Path $codexExtensionRoot 'package.json') -Raw |
     ConvertFrom-Json | Select-Object publisher, name, version
   ```

3. Dry-run and validate. Stop on any failure; do not bypass a version or source check.

   ```powershell
   node integrations/codex/question-dismissal.cjs "$codexExtensionRoot" --follow-ups
   if ($LASTEXITCODE -ne 0) { throw 'Patch inspection failed' }

   yarn test --runInBand integrations/codex/question-dismissal.test.ts integrations/codex/question-follow-up-dismissal.test.ts src/main/codex-question-service.test.ts
   if ($LASTEXITCODE -ne 0) { throw 'Regression tests failed' }

   node dev-infrastructure/smoke-codex-question-dismissal.cjs "$codexExtensionRoot"
   if ($LASTEXITCODE -ne 0) { throw 'Question synchronizer checks failed' }

   node dev-infrastructure/smoke-codex-question-follow-ups.cjs "$codexExtensionRoot"
   if ($LASTEXITCODE -ne 0) { throw 'Cross-turn watcher checks failed' }
   ```

   The smokes execute installed extension functions in isolation, applying the
   proposed patch in memory. They do not modify the extension or send messages.
   Dry-run `changed: false` means the complete patch is already present.

4. Apply. This overwrites one installed JavaScript asset after retaining an exact,
   uniquely named `.bak` beside it. Save the printed asset path, backup path, and
   before/after hashes. An already-patched installation returns `alreadyApplied`.

   ```powershell
   node integrations/codex/question-dismissal.cjs "$codexExtensionRoot" --follow-ups --apply
   if ($LASTEXITCODE -ne 0) { throw 'Installation failed; inspect the reported backup' }
   ```

5. Repeat both smoke commands against the installed asset, then repeat the dry
   run. Require both smokes to pass and `changed: false`.

6. Run **Developer: Reload Window** in each affected VS Code window. Restarting
   Tray alone does not reload the extension's bundled UI.

## Port after an OpenAI update

First test the new unmodified extension. If OpenAI has fixed both behaviors,
retain the evidence and stop applying this workaround.

Otherwise:

1. Read the new manifest and the loaded `webview/assets/app-initial-*.js` bundles.
   Locate the reply parser, selected-editor synchronizer, and its reactive turn
   watcher by their behavior. Minified names can repeat in different bundles;
   verify the containing module, imports, and function bodies.
2. Reproduce both failures using the new extension's actual functions: an accepted
   external answer in the same turn, and an answer in a later turn after the
   question's turn finishes. A pending-question reducer alone does not exercise
   the selected editor or watcher subscriptions.
3. Port the exact source patterns and replacement code in
   `question-dismissal.cjs`. Update the verified version only after inspecting the
   new implementation. Preserve unique-match checks, refusal on unexpected code,
   idempotence, backups, and post-write hash verification.
4. Port the installed-code smoke extractors to the new symbols and module layout.
   Verify each referenced atom/helper, particularly the ordered turn list, item
   subscriptions, turn materialization, and selected question state. Add new
   regressions; obtain approval before changing pre-existing tests, per AGENTS.md.
5. Run the tests and dry-run installation procedure above. Record the new version,
   target asset, hashes, backup, and test results in this guide and the related
   plan files. Retain older backups; never copy an older bundle over a newer release.

Useful symbol map for **26.1007.21434 only**:

| Purpose | Existing symbol |
| --- | --- |
| Reply envelope and question ID helpers | `n8t`, `i8t` |
| Question definitions and accepted replies | `qv`, `Jv`, `Lit`, `D_t` |
| Selected-editor synchronization | `rRt`, `RD`, `HD`, `VD`, `BD` |
| Reactive question watcher | `QLt` |
| Ordered turn identities | `rm` (imported as `zSt`; source symbol `dD`) |
| Original turn materialization | `Kd` (imported as `jSt`; source symbol `$nn`) |
| Turn metadata, item IDs, relevant items | `eu`, `ou`, `tRt` |

`--follow-ups` changes only the watcher's transient input to the synchronizer;
it must not mutate stored turns, send another reply, or change question identity.

For the separate local message route, this read-only check is also available:

```powershell
$env:CODEX_EXTENSION_ROOT = $codexExtensionRoot
node dev-infrastructure/check-codex-local-admission.cjs
```

That checker also contains version-specific symbols and must be reviewed on
updates. `smoke-codex-questions.cjs` currently has a separate extractor failure
(`Missing extension function Rxn`); it is not a substitute for the two dismissal
smokes above. Port its extractor before claiming that broader smoke passes.

## Manual acceptance after reload

Ask a fresh async question, wait until the assistant's turn finishes, and answer
through Tray. Confirm both delivery and disappearance of the VS Code dialog.
Also check an answer during an active turn, partial answers, and an unsent local
draft. Unaccepted/failed replies and ordinary messages must leave questions open.

Record visible dismissal separately from message delivery and isolated test
results. A received answer alone does not establish that the editor closed.

## Rollback

Use the exact backup printed by the corresponding installation, for the same
extension version and asset. A later backup may already contain the first patch.
The following restores the chosen snapshot and retains the current asset first:

```powershell
$codexPatchAsset = 'C:/path/to/current-extension/webview/assets/app-initial-EXACT.js'
$codexPatchBackup = 'C:/path/to/current-extension/webview/assets/app-initial-EXACT.js.tray-question-dismissal-EXACT.bak'
Get-FileHash -Algorithm SHA256 -LiteralPath $codexPatchBackup
# Verify this is the intended asset/version and recorded backup hash before copying.
Copy-Item -LiteralPath $codexPatchAsset -Destination ($codexPatchAsset + '.before-rollback-' + [guid]::NewGuid() + '.bak')
Copy-Item -LiteralPath $codexPatchBackup -Destination $codexPatchAsset -Force
Get-FileHash -Algorithm SHA256 -LiteralPath $codexPatchAsset
```

Require the restored hash to match the chosen backup, then reload affected VS
Code windows. No files need to be deleted.

## Verified installation record — 2026-10-22

Asset: `webview/assets/app-initial-c014f9ee4429.js` in version `26.1007.21434`.

| State | SHA-256 |
| --- | --- |
| Original OpenAI asset | `aabbfa7c366706365a239b090ca1c657b6a0213d7287e54ef0a32d1b2e5ff6a0` |
| First dismissal patch | `b0f595dca8a1bd486b2f0cba2d9108ee33fbde142518ce21b39b82003c2392b8` |
| Both patches installed | `6d2e3ed469c0f2967b635dddbcdb04bc1255c1b4536f94e9471503860c482d9c` |

Backups beside that asset:

- Original asset: `app-initial-c014f9ee4429.js.tray-question-dismissal-9310cfde-578b-40bc-835c-3826e6e75103.bak`.
- First-patch state: `app-initial-c014f9ee4429.js.tray-question-dismissal-35e11d34-fa4e-4f5b-b03f-886b13143400.bak`.

The 34 targeted tests and both installed-code dismissal smokes passed. The latest
live test confirmed answer delivery; explicit visual dismissal acceptance remains
unrecorded. These are historical results, not validation of a future release.

Related records: [original dismissal](CODEX-QUESTION-DISMISSAL-PLAN.md),
[cross-turn fix](CODEX-QUESTION-FOLLOW-UP-PLAN.md), and
[Tray question answers](CODEX-QUESTION-ANSWER-PLAN.md).
