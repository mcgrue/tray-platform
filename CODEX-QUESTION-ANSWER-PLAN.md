# Answer Codex questions from Tray Platform

Add an Answer question composer beside Message Codex. Read the original async
question call from the matching local Codex session transcript, verifying the
session/turn/call against the attention item ID. This also supports existing
inbox items without guessing question text from their truncated descriptions.

Submit one structured `send_user_message_question_reply` envelope through the
existing owner-routed send path. Require answers for every remaining question;
preserve drafts on failure, never replay uncertain delivery, and mark the Tray
item Done only after acknowledgment. Ordinary messages keep their behavior.
Blocking questions remain in Codex because they require a different protocol.

Validate with new regression tests, the existing suite, an isolated Electron
smoke, and the installed extension's actual pending-question recognition code.
Keep installed-client visual acceptance distinct from these checks.

# HUMAN QUESTIONS

None blocking.
