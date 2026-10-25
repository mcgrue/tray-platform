# Phone approvals

Status: implemented and automated checks passed, 2026-10-25; physical-phone
acceptance pending. Approved scope: command/file
approvals from Tray-managed Codex conversations, shared between desktop and PWA.

## Implementation

- Replace native approval dialogs with inbox cards. Show exact command, working
  directory, permissions/network context, or proposed file changes before allowing
  a one-time decision. No policy/session grants. Unsupported or incomplete
  requests remain declinable without enabling Allow once.
- Track each server request by its live runtime and JSON-RPC identity. Carry
  cancellation and response-write acknowledgement into the approval service.
- Persist card status, never live approval authority. Expire on runtime loss,
  turn completion, server resolution, or app restart. Serialize competing clients;
  send at most one decision, with no reconnect replay.
- Expose guarded IPC and authenticated PWA routes with existing delivery receipts.
  Reserve approval-source writes from the generic attention API. Pending approvals
  cannot be dismissed with Done.
- Keep cards compatible with collapsed phone UI and notification expansion.

## Validation

Unit coverage: wire identity, duplicate decisions, unsupported decisions, missing
file context, disconnect/cancellation, restart, persistence failure, and API guards.
Browser/Electron smoke: approve/decline, concurrent clients, lost response recovery,
expired cards, collapsed layout, and literal request rendering. Use isolated
fixtures; never approve operations in a live user conversation as an automated test.
Build/typecheck and existing relevant regressions. Real-phone acceptance is
separate from automated Chromium evidence.

Results:
- Jest: 469 tests across 60 suites, including new approval lifecycle, concurrent decisions,
  restart, storage failure, protocol cancellation, proposal identity, and API guards.
- Build and focused strict TypeScript check passed.
- Desktop/phone approval smoke passed; screenshots inspected. Literal commands,
  readable file diffs, narrow layouts, push deep links, keyboard Decline,
  conflicting decisions, lost-response recovery, and offline/expired controls.
  Evidence: `%TEMP%/tray-approval-smoke-44pkEZ/`.
- Existing inbox, PWA, instance composer, and installed-runtime project-session
  smokes passed. Expected failure-path diagnostics remain expected.
- Installed-runtime command/file approval smoke passed with isolated config,
  history, a localhost provider, a harmless command and temporary source files.
  Both Allow once and Decline produced their expected runtime item status; only
  the allowed file was created. Evidence: `%TEMP%/tray-approval-runtime-OHdxNb/`.
- The user confirmed the test notification arrived on their phone. A real
  phone Allow once/Decline interaction remains unverified.
- Restart Tray and refresh the phone PWA to load the feature. The live application
  was not restarted because that would stop its currently owned conversations.

Protocol reference: https://learn.chatgpt.com/docs/app-server#approvals
Installed runtime schemas generated with `codex app-server generate-ts --experimental`.

# HUMAN QUESTIONS

- Resolved by the implementation request: phone approvals are the next feature.
- Default from the proposed plan: the inbox is the common approval surface.
- Existing affected tests and smoke changes approved by the user.
- Real phone acceptance: verify a fixture approval after the built app is restarted.
