# Dismiss externally answered Codex questions

The installed `openai.chatgpt` extension, version `26.1007.21434`, recognizes
structured replies from Tray Platform but leaves its question editor selected.
Its question-state synchronizer updates `lastSubmission` without clearing the
selected editor; only its own submit handler clears that selection. Reproduced
by executing the installed synchronizer with an accepted external answer.

Prepare an optional, version-checked local workaround in
`integrations/codex/question-dismissal.cjs`. It removes answered questions from
the open editor, keeps unanswered questions and unsent local draft edits, and
closes the editor when nothing remains. It sends no messages and changes no
conversation history. An existing test helper only checks the pending-question
reducer, which does not cover the separate open-editor selection state.

The patch defaults to a dry run, verifies an exact source match, and creates a
unique backup before installation. Extension updates can overwrite it; an
unknown version or changed implementation must be reviewed again. Applying it
requires reloading the affected VS Code webviews/windows to load the new code.
Restoration is copying the reported backup over the patched asset, then reloading.

Validate the original and patched synchronizers directly from the installed
extension, covering accepted and pending replies, partial answers, unrelated
questions, and unsent local drafts. Also run the existing answer service tests.

# HUMAN QUESTIONS

- Resolved: the user approved installing the reversible local extension patch.

The patch was installed after approval. No existing test files were modified.

## Validation (2026-10-22)

- 47 tests passed across the new patch tests and existing question/message services.
- `smoke-codex-question-dismissal.cjs` reproduced the stale editor with the
  installed source, then passed 11 checks with the patch applied in memory.
- Dry run verified the target asset; its original SHA-256 is
  `aabbfa7c366706365a239b090ca1c657b6a0213d7287e54ef0a32d1b2e5ff6a0`.
- Installed SHA-256:
  `b0f595dca8a1bd486b2f0cba2d9108ee33fbde142518ce21b39b82003c2392b8`.
- Repeated all 11 synchronizer checks against the installed patched asset; passed.
- Original asset retained alongside the patched file as
  `app-initial-c014f9ee4429.js.tray-question-dismissal-9310cfde-578b-40bc-835c-3826e6e75103.bak`.
- Affected VS Code windows must reload. Live visual acceptance remains pending.
