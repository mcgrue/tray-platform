# Dismiss questions answered in a later turn

The 2026-10-22 live test delivered the answer in a new turn while the VS Code
question dialog remained open. The existing local dismissal patch watches only
the turn that contains the question. Its same-turn smoke did not cover this case.

Extend the optional patch with `--follow-ups`. Watch later turns in the same
conversation and pass their user replies to the existing question synchronizer.
Keep history unchanged, retain unanswered questions and unsent local drafts,
and ignore unaccepted steering replies. Installation retains an exact backup;
VS Code must reload the webview to load the updated asset.

Validate by executing the installed watcher and synchronizer in isolation with
separate turns, including reactive pending-to-accepted updates, partial answers,
foreign questions, and drafts. Keep live visual acceptance separate.

## Verification

- The installed watcher reproduced the stale dialog when the reply arrived in
  a separate turn. The prepared watcher passed the same reproduction, reactive
  acceptance, partial-answer, draft, and conversation-isolation checks.
- 34 targeted tests passed, including the unchanged original patch tests.
- Previous asset SHA-256:
  `b0f595dca8a1bd486b2f0cba2d9108ee33fbde142518ce21b39b82003c2392b8`.
- Installed asset SHA-256:
  `6d2e3ed469c0f2967b635dddbcdb04bc1255c1b4536f94e9471503860c482d9c`.
- Installed after explicit approval. Both the cross-turn watcher checks and all
  11 original synchronizer checks passed against the installed asset.
- The previous asset is retained alongside it as
  `app-initial-c014f9ee4429.js.tray-question-dismissal-35e11d34-fa4e-4f5b-b03f-886b13143400.bak`;
  its hash matches the previous asset hash above.
- Affected VS Code windows must reload. Live visual acceptance remains pending.

# HUMAN QUESTIONS

- Resolved: the user approved installing the cross-turn fix.
