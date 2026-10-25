# Tray Platform next features

Feature order, 2026-10-25. Phone approvals implemented and automated checks passed;
physical-phone acceptance pending. Remaining features are recommendations.

## Current foundation

Desktop and PWA have the Attention Inbox, Codex instance activity, conversation
selection and messaging, and new project conversations. Phone cards collapse,
preserve drafts, and support notification links. Local files can be previewed on
the phone, including highlighted source. Context bookmarks exist on desktop.

## 1. Phone approvals for Tray-managed conversations

Implemented with a shared inbox for command and file approvals from
`CodexProjectSessions`. See `PHONE-APPROVALS-PLAN.md` for scope and validation.

- Put those requests in the existing inbox with project, conversation, and the
  supplied command or file-change details. Expose Allow once and Decline on both
  desktop and phone; preserve the configured Codex approval policy.
- Resolve one pending request from either client. Show resolved or expired state
  on the other client, and never apply a late response to another request.
- Reuse the PWA authorization, receipt, and notification paths. On runtime loss
  or restart, expire the request instead of replaying a decision.
- Initially cover Tray-managed sessions. Approval control for conversations owned
  by the VS Code extension needs a separate feasibility check.
- Verify allowed/declined flows, concurrent responses, lost acknowledgements,
  runtime exits, and an actual phone interaction before calling it complete.

## 2. Conversation history and live output

Add an Open conversation entry to the instance menu/picker: recent messages,
current activity, live assistant output, and the existing reply composer together.
Start with Tray-managed conversations, where output is already collected in
`src/main/codex-project-sessions.ts`; verify history and live updates for externally
owned conversations before extending coverage. Keep output updates from moving
the user's scroll position or replacing drafts.

## 3. Inbox search and project filters

The inbox currently filters by Pending/Done. Add project and text filters
with visible result counts, preserving them across updates and tab switches.
Notification links must still reveal their target even when it is filtered out.
This is the smallest independent feature if remote approvals are not a priority.

## Later backlog

Keep the candidates in `TODO-FUTURE-PLANS.md`: attention-aware sounds and return
summaries, quick thought capture, transition reminders, project handoff, exact
browser-tab activation, and a broader job board. Codex activity already provides
part of the running/waiting visibility; a general build/test/job board would add
explicit reporting and heartbeats for other producers.

# HUMAN QUESTIONS

- Resolved: phone approvals first, using the shared inbox on desktop and phone.
- For the first conversation view, is Tray-managed session coverage sufficient,
  or is viewing VS Code-owned conversations a release requirement?
