# Tray Platform reliability and triage improvements

Suggestions based on local HEAD `ebb418c`, reviewed 2026-10-26. Item 4 implemented
locally on user request; other items remain recommendations.
Conversation history/live output and inbox search/project filters remain in
`TRAY-FEATURE-NEXT-STEPS-PLAN.md`; the candidates below add to that backlog.

## 1. Recover unsent drafts

Current composers preserve drafts in memory, but reloads and app exits lose them
(`src/app/codex-message-ui.ts`, `src/app/codex-instance-composer.ts`, README).

- Persist text and destination by project/conversation or attention-item identity.
- Restore after app restart or phone page reload. Require destination revalidation
  when the original process has restarted; never silently select another thread.
- Start with text recovery. Clearly flag attachments that need re-selection;
  persisting file contents is a separate scope decision.
- Clear the sent revision only after confirmed delivery; retain newer edits.
- Verify reload, process replacement, missing conversations, and lost responses.

## 2. Put actionable questions first

`visibleAttentionItems()` in `src/app/attention-ui.ts` currently orders all pending
items newest first, mixing questions, approvals, and completion notices.

- Add a Needs me view for unresolved questions and actionable approvals.
- Show separate decision and completion counts; retain the full Pending view.
- Within the decision view, expose oldest waiting items first and show their age.
- Keep partial questions visible and respect notification deep links.
- Verify partial replies, expired approvals, and fresh completion bursts.

## 3. Recover interrupted Tray-managed work

Tray closes its managed runtimes on quit (`src/main/main.ts`). Runtime ownership
and active-turn maps are in memory (`src/main/codex-project-sessions.ts`). Runtime
failures already produce notices; recovery should build on that behavior.

- Persist a minimal journal of project, conversation, and active turn identifiers.
- On launch, reconcile saved records with runtime/history evidence and present
  unfinished work with Open conversation and an explicit follow-up action.
- Show affected active sessions before an intentional quit.
- Resume only after user action; do not replay a message or approval automatically.
- Verify normal quit, crash/restart, completed-before-crash, and unavailable projects.

## 4. Explain Unknown activity - implemented locally

Activity now carries bounded reason codes and the last confirmed activity time
(`src/main/codex-activity.ts`, `src/app/codex-activity-icon.ts`).

- Reasons distinguish history/mapping gaps, unavailable processes/connections/owners,
  snapshot timeouts, protocol/state incompatibility, resuming, and failed checks.
- Visible desktop details and expanded phone entries show the explanation,
  last-confirmed timestamp (or no confirmed observation), and Refresh now.
- Stale checks override old reasons; confirmed recovery removes the explanation.
- Last-confirmed times survive failed checks and rescans within this Tray run,
  keyed by PID/start time. They do not transfer to a restarted process.
- Added dedicated reader, service and presentation tests plus desktop/phone smoke
  coverage for refresh recovery, offline controls, focus, expiry and narrow layouts.
- Existing tests are unchanged. Build and normal entry-point typecheck pass;
  strict checking passes for changed modules. Whole-app strict checking still
  reports the existing possibly-undefined instance in `codex-attention.ts:85`.

## 5. Make attachment storage manageable

`src/main/codex-attachments.ts` caps retained copies at 512 MiB / 5,000 records;
its full-storage error directs users to desktop management, but no management UI
was found in this checkout.

- Show usage, retained files, sizes, and known conversation references.
- Provide preview and export before user-selected cleanup.
- Require explicit confirmation for deletion and explain that saved conversation
  file references may stop working. Do not delete automatically.
- Verify quota accounting, rejected uploads, and explicitly selected cleanup.

# HUMAN QUESTIONS

These choices are deferred until a feature is selected for implementation.

- Draft recovery: device-local text only first, or cross-device recovery too?
- Needs me: additional view, or the default landing view?
- Active-session quit: cancel-or-quit prompt, or also wait for sessions to finish?
- Attachment storage: usage/inspection first, or include confirmed cleanup?

## Suggested sequence

Draft recovery, Needs me, interrupted-work recovery, activity diagnostics, then
attachment storage management. Add focused tests and desktop/PWA smokes for each
implemented feature; obtain approval before changing pre-existing tests.
