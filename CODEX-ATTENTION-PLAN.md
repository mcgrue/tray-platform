# Codex questions in the attention inbox

Status: bridge implemented, installed globally, and trusted on 2026-10-20. Global agent guidance and README installation instructions are installed/documented. Runtime-to-inbox integration, refreshed automated checks, and delivery of a real question from this VS Code session passed. The live tray process has restarted since initial installation. Other VS Code sessions still need acceptance. See [verification results](CODEX-ATTENTION-VERIFICATION.md).

## Verified locally

- Installed VS Code extension: `openai.chatgpt` version `26.1007.21434`; bundled runtime: `0.162.0-alpha.17.2`. Its feature listing reports hooks enabled.
- User configuration already invokes `C:\Users\benmc\.codex\codex-notify.ps1` for turn completion and `PermissionRequest`.
- That script explicitly ignores every other event. It sends a GET to a configured sound URL, currently a Tailscale address on port 22222, without question/session details.
- The repository now contains the attention API: `PUT /api/attention/:source/:id` and `POST /api/attention/:source/:id/state`. Its routes require loopback callers. Existing work must be preserved and rechecked before integration.

## Verification result (2026-10-20)

- PASS: `request_user_input` fires `PreToolUse` before the client receives the blocking question. `PostToolUse` fires after the client answers and includes the answer.
- PASS: `request_user_input_async` fires `PreToolUse` before the asynchronous question item. Its `PostToolUse` fires immediately with `{"accepted":true}`, without an answer.
- Both events include `cwd`, `session_id`, `turn_id`, `tool_use_id`, and the question arguments. The exact matcher `^request_user_input(_async)?$` worked.
- Tested through the actual extension-bundled app-server with deterministic local model-response fixtures and isolated, trusted hooks. VS Code visual rendering and delivery to the live tray inbox were outside this test.

## Implementation

1. Complete: verify the runtime question protocol and hooks for both tool names. Use the confirmed `PreToolUse` matcher `^request_user_input(_async)?$` for notification creation.
2. Complete: standalone Node bridge, background user-level hook, 1.5-second HTTP deadline, successful hook exit on delivery failure, and session/turn/call deduplication. Create-only PUTs preserve all existing item fields. Existing completion/approval hooks are preserved.
3. Complete: same-machine loopback delivery. The current Tailscale sound URL remains independent.
4. Complete: questions stay pending until manual Done. Answering or cancelling does not automatically clear them. Async PostToolUse must not be treated as an answer.
5. Complete: 11 new bridge/installer tests, 96 total Jest tests passing, build passing, and two independent extension-bundled runtimes delivering through actual async hooks into an isolated Electron inbox. Rendering, sound counts, retries, and manual Done passed. Two runtimes also delivered to the live inbox; installed-bridge replay passed and test entries were marked Done.
6. Remaining manual acceptance: reload existing VS Code sessions and observe naturally generated questions in two windows. Computer-use guidance disallows automating the Codex extension UI. Automatic window/conversation targeting remains separate work.

Codex documents user-level hooks, tool-name matching, JSON input with session/cwd metadata, and trust review for new hooks. The question-specific route is now verified for the installed runtime version. [Official hook documentation](https://learn.chatgpt.com/docs/hooks)

The older `notify` setting currently covers only turn completion. [Official notification documentation](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications)

# HUMAN QUESTIONS

- Resolved by approval of the proposed next steps: persistent entry plus one sound.
- Resolved initial scope: local instances; authenticated remote delivery is separate work.
- Resolved initial scope: manual Done.
