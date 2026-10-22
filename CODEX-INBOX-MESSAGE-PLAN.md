# Send messages from Codex attention items

Add an inline message composer to Codex inbox cards. Deliver to the conversation
identified by the hook, through the existing Codex client's local IPC router.
Steer an active turn; start a follow-up only after an explicit inactive-turn
rejection. Retain drafts on failure and leave Done/Snooze under human control.

The installed Windows extension (openai.chatgpt 26.1007.21434) exposes the
`codex-ipc` named pipe and versioned owner-discovery/follower requests. Live
read-only discovery found owners for existing inbox sessions. This is an internal
extension protocol; unsupported versions must fail visibly without replaying.
The public [app-server protocol](https://learn.chatgpt.com/docs/app-server)
documents turn start/steer, but does not provide attachment to an existing
extension's stdio connection.

Persist the session ID on new items. Older hook items remain usable only when
their fixed description header hashes to their original question ID. Resolve
the conversation owner for every send; do not start a second Codex process.
Keep the message endpoint in Electron IPC, outside the HTTP notification API.

Validation: new service/transport tests, existing suite, build, and isolated
Electron renderer/preload/main/named-pipe smoke. Preserve pre-existing tests.

# HUMAN QUESTIONS

None blocking. Free-form messages remain distinct from structured question
answers and do not automatically mark an attention item Done.

## Verification

- Build and Jest suite passed. New tests cover session persistence, legacy
  identity verification, owner targeting, active/idle delivery, duplicate sends,
  fragmented pipe messages, disconnects, timeouts, and malformed responses.
- `smoke-codex-messages.cjs` passed with an isolated Electron profile, a fixture
  extension router, and the installed extension-bundled Codex runtime using
  deterministic local responses. Both idle follow-ups and steering reached the
  runtime's provider input. UI failure feedback and retained drafts were checked
  visually in `composer.png` in the smoke's retained evidence directory.
- Live installed-client owner discovery passed. Sending through the installed
  VS Code UI's owner handler still requires human acceptance; no messages were
  injected into existing working conversations during automated validation.
