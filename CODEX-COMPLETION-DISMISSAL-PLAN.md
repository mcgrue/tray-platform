# Codex completion dismissal

Sending a message in a conversation automatically moves its earlier Codex completion attentions to Done. Match the exact session; preserve unanswered questions, other sessions, item content, and history.

## Implementation

- Extend the existing UserPromptSubmit hook using the existing loopback inbox and state APIs.
- Track completion delivery and acknowledgement by identifiers in a separate completion-state directory. Preserve manually reopened entries on duplicate delivery and handle a prompt racing an in-flight completion delivery.
- Exclude the submitted turn's own completion and capture the candidate set once per prompt, so delayed/repeated prompt delivery cannot consume a newer result.
- Add new regression tests and an isolated runtime/Electron smoke; leave existing tests unchanged.
- Install the updated bridge with backups after validation. No new hook definitions or app API changes are needed.

# HUMAN QUESTIONS

- Resolved: interaction means sending a message in the same conversation (user selected this over viewing the conversation or general VS Code activity).
- No outstanding decisions.

## Validation

- Implemented and installed in the user-level bridge. Installed files match repository bytes; hooks.json is unchanged, so no reload or restart is needed. The installer retained a backup of the previous bridge.
- Full Jest suite: 39 suites, 294 tests passed. Existing test files were unchanged by this task.
- Final focused regression run: 12 completion dismissal tests passed, including process boundaries, pre-upgrade items, creation races, failed delivery/retries, newer results, and question isolation.
- `yarn pre-build` and `git diff --check` passed.
- Real Codex runtime (VS Code extension 26.1021.22027) and Electron smoke passed using a local deterministic provider: prior completion moved to Done on UserPromptSubmit, unanswered question and other session remained pending, next result remained pending, history and sounds were preserved.
- Screenshot inspected; retained evidence: `C:\Users\benmc\AppData\Local\Temp\tray-completion-dismissal-smoke-nXjPOK\result.json` and `inbox.png`.
- Dismissal remains best effort when Tray is unavailable. A later message or retry can finish it; no background replay worker was added.
