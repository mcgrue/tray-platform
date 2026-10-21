# User-level Codex attention reporting

Status: user-level question hook and global guidance installed, 2026-10-20. README installation instructions are updated. Automated checks passed again, and a real question from this VS Code session reached the live inbox. Other VS Code sessions still need acceptance.

## Objective

Give local Codex agents a consistent instruction to surface questions through Tray Platform, across repositories and VS Code windows.

## Current state

- `C:\Users\benmc\.codex\AGENTS.md` includes the attention-reporting rule under `Questions requiring human input`. Existing content was preserved and a backup retained. This conversation received the updated instructions. No global `AGENTS.override.md` was found during installation.
- `C:\Users\benmc\.codex\hooks.json` already registers the question bridge for `PreToolUse` with matcher `^request_user_input(_async)?$`.
- The installed bridge is `C:\Users\benmc\.codex\tray-platform\attention-hook.cjs`. It forwards question text, choices, cwd, and session/turn/call identifiers to the local inbox.
- The bridge's installation record reports trusted status. Recheck effective hook status in each target runtime during rollout.
- Native question tools are supplied by the Codex runtime. Instructions can govern their use when available; instructions cannot create unavailable tools or override their mode restrictions.
- Completion and permission notifications currently use the independent sound-only path. Question items require manual Done; the bridge does not automatically select the originating window.

## Installed global guidance

The following guidance has been appended to the existing global `AGENTS.md`, preserving current content and retaining a backup. The README contains the installation instructions for other profiles.

```markdown
## Questions requiring human input

- When you need a human decision, clarification, or missing information, use an available structured question tool, subject to its documented restrictions and the current session's instructions.
- Use request_user_input_async when available for questions during ongoing work. Use request_user_input when available and permitted by the current mode.
- Include enough project/task context in the question for the human to identify the work from a notification.
- The user-level Tray Platform hook creates the attention entry for these tool calls. Do not also send a separate notification for the same question.
- Ask only when the answer is needed; do not invent questions to trigger notifications. Continue independent work while an asynchronous answer is pending.
- If neither question tool is available, ask in chat and explicitly note that this question was not submitted through the attention hook.
```

This is behavioral guidance, not guaranteed event delivery. The hook can observe calls that occur; it cannot detect every unexpressed need for human attention. A stopped tray process currently causes failed delivery without a retry queue.

## Remaining work

1. Trigger a deliberately labelled test question from a real Codex conversation in another VS Code window, such as Breaditor. Check the question appears both in Codex and the live inbox with correct context and one sound, then mark the test entry Done. Repeat in a second client/runtime to verify shared user scope. Check effective hook trust/loading if either entry is absent.
2. Automated validation was refreshed before committing: all 96 tests, the build, and the isolated Codex-to-Electron smoke passed. Evidence is recorded in `CODEX-ATTENTION-VERIFICATION.md`.
3. Review and commit the integration source, installer, new tests, API changes, smoke fixtures, and documentation as a coherent change. Preserve unrelated untracked files and tool directories.
4. Resolve the completion policy below before extending coverage. Completed-turn sounds still bypass the inbox.

## User scope and rollout checklist

1. Back up and append the global instruction block. Do not create an override file that would shadow the current instructions.
2. Reuse the existing global hook. Check its effective enabled/trusted status; avoid installing duplicate handlers.
3. Reload/reopen Codex sessions, or start new sessions, and verify the new instruction is present. Do not assume edits are injected into an already-running turn. Do not terminate active work to accomplish this.
4. Cover clients using this same Windows user's Codex home. Separate `CODEX_HOME` profiles, WSL, containers, remote hosts, and other OS users require their own configuration and delivery arrangement.
5. Verify from two repositories/windows and the CLI: one real question produces one entry with correct context and one sound. Check both question types where the runtime exposes them. Distinguish real model instruction-following from deterministic bridge smoke coverage.
6. If code is subsequently modified, add focused new tests and run the existing bridge/runtime smoke checks. Ask before changing any pre-existing tests.

## Broader attention coverage, if wanted

The existing loopback API already supports explicit submissions using `PUT /api/attention/:source/:id`. A small user-installed CLI helper can expose that API to agents with shell access, regardless of native question-tool availability. Keep a stable identity per attention request and use create-only delivery for retries. Surface delivery failures without blocking agent work. Only attach a destination when it is positively identified.

If named model tools are preferred, an MCP adapter around the same API is an alternative. It would be a new implementation, separate from the native Codex question tools, with user-level registration and instructions defining when to call it.

Completion coverage should use the actual completion event. Do not make agents ask artificial questions or turn every legacy sound request into an inbox entry. Permission prompts likewise have their own event and need a separate integration if they should appear in the inbox.

# HUMAN QUESTIONS

- Scope: start with the existing question tools plus global guidance, or also build an explicit reporting helper for agents without those tools? Recommendation: install the guidance first; add the helper if universal reporting is required.
- Completion policy: should every completed turn create an inbox entry, or should entries be limited to questions, blockers, and explicit requests for review? This determines whether Breaditor-style completion pings should enter the inbox.
- Resolution policy: retain manual Done, or add verified answer-to-item resolution? Asynchronous PostToolUse acknowledges the question submission, not a human answer, so it cannot resolve the item.

## Sources

- [OpenAI: global AGENTS.md discovery and instruction loading](https://learn.chatgpt.com/docs/agent-configuration/agents-md).
- [OpenAI: hook configuration, matching, and trust](https://learn.chatgpt.com/docs/hooks).
- Local implementation: `integrations/codex/attention-hook.cjs`, `integrations/codex/install.cjs`, and `README.md`.
