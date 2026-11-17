# Codex turn controls in Attention Monitor

## Implementation status (2026-11-11)

Implemented in both desktop and phone composers. Selected settings travel with
the next message; a confirmed active-turn rejection keeps the draft ready for a
later send. The installed app-server accepted a Plan turn with high effort in an
isolated local-provider conversation, and the following plain turn inherited
the effort. The installed extension's owner IPC shape was inspected, and
fixture-backed desktop and phone sends passed.

The VS Code owner does not expose the current collaboration mode through its
read-model-settings request, so the UI says **mode unknown** until a future
read API exists. A saved project thread with no live owner likewise cannot
verify its effective model/effort; mode-only changes require explicit model
and effort choices there. A live VS Code-owned selected turn and physical-phone
interaction have not been exercised.

## Goal

Let a user choose Plan or Default mode, a model, and reasoning effort for the
next Codex instruction sent from the Attention Inbox or Codex Instances view on
desktop and phone. Show the current settings when they can be verified. Keep
the existing message-only behavior when the user leaves the controls alone.

## Current integration

- `CodexProjectSessions` owns some project conversations through app-server.
  It starts new threads and sends idle turns with `turn/start`, but currently
  passes no mode, model, or effort.
- Other conversations are owned by the VS Code extension. `CodexMessageService`
  discovers that owner and sends through its versioned internal IPC protocol.
  It steers active turns and starts idle follow-ups.
- The installed extension exposes internal `thread-follower-read-model-settings`
  and `thread-follower-update-thread-settings` requests. Their payloads and
  compatibility need a live, isolated protocol proof before production use.
- App-server documents `model/list` with supported efforts, `turn/start`
  overrides for model/effort/collaboration mode, and no turn-level overrides on
  `turn/steer`: https://learn.chatgpt.com/docs/app-server
- The installed app-server's generated schema says a `collaborationMode`
  payload contains `mode` plus `settings.model`, `settings.reasoning_effort`,
  and `settings.developer_instructions`. That payload takes precedence over
  separate `model` and `effort` fields. Resolve the effective model/effort before
  changing mode alone, so Plan does not silently change either value.
- Phone sends use receipt-backed HTTP delivery. A settings choice must travel
  with the same delivery request as its message so recovery cannot send an
  instruction with different settings.

## Proposed behavior

- Put Mode, Model, and Reasoning effort selectors in both message composers.
  Each starts at **Use conversation setting**. Mode offers **Plan** and
  **Default**; model choices and their effort choices come from a fresh
  `model/list` response, not a hard-coded list. Preserve a selected draft when
  the composer closes, the instance list refreshes, or delivery is uncertain.
- Apply explicit selections with the next sent instruction. A successful
  override becomes the thread's setting for later turns; refresh the displayed
  effective values after acknowledgement. Selection alone does not start work.
- If an explicit selection is present while the turn is active, retain the
  entire draft and show that the change requires a new turn. Never silently
  steer that instruction using the old settings, interrupt work, or replay an
  uncertain delivery. A message with no selections keeps today's steering path.
- If a catalog or current-setting read is unavailable, show **Unavailable**
  and leave the existing message composer usable. Disable any selection whose
  safe payload needs an unknown current value. Reject unsupported model and
  effort combinations on the main process as well as in the UI. A catalog is
  not proof of account entitlement; show the provider's rejection clearly
  enough for the user to choose another option.
- Keep choices scoped to the selected conversation. Do not write global
  `config.toml` defaults or change an unrelated Codex instance.

## Implementation steps

1. **Verify protocols.** Against the installed Codex binary and VS Code
   extension, confirm the collaboration-mode payload, `model/list` pagination,
   how owned and resumed threads expose their current settings, and whether the
   VS Code owner accepts turn-level overrides atomically on
   `thread-follower-start-turn`. Probe an isolated
   fixture conversation, not a user's working thread. Record a version/capability
   gate for internal IPC. If an atomic override is unavailable, determine whether
   the owner's settings-update request plus an idle-turn guard is safe; otherwise
   disable controls for that owner with an explicit explanation.
2. **Add a shared contract.** Define optional mode/model/effort fields and a
   bounded settings/catalog response in `src/shared`. Extend both desktop
   preload IPC and the phone HTTP bridge. Include options in the existing
   receipt-backed message request; validate conversation ownership, model ID,
   supported effort, and mode again in the main process.
3. **Wire owned sessions.** Read the catalog through their app-server runtime.
   Put a selected model on `thread/start` for new threads and put validated
   selections on `turn/start`. When selecting Plan or Default, build its complete
   `collaborationMode.settings` from the verified effective values plus explicit
   choices; do not rely on separate model/effort fields to override it. Keep the
   existing request unchanged when no override is selected. Refuse an explicit
   override for an active turn; preserve plain-message `turn/steer` behavior.
4. **Wire VS Code-owned sessions.** Read settings from the verified owner,
   discover it again at send time, and apply the same new-turn rule. Use only a
   protocol shape proven against the installed version. Reject owner movement,
   unsupported versions, mismatched provider/catalog, and ambiguous outcomes
   without a second send or a new Codex owner.
5. **Build the selectors.** Share selector logic between the Inbox and Instances
   composers; keep draft state isolated per item/conversation and instance.
   Show effective setting versus pending selection, filter effort choices when
   model changes, and keep keyboard and phone layouts usable. Reconcile a
   confirmed phone receipt with the exact message and settings draft.
6. **Validate.** Add new service/transport/UI tests for default behavior,
   Plan/Default transitions, compatible and incompatible model/effort pairs,
   active turns, owner changes, stale catalogs, timeouts, and phone recovery.
   Run the existing Jest suite and `yarn pre-build`, then isolated Electron and
   phone smokes. Perform a real installed-client smoke only in a disposable
   conversation. Report local validation separately from live VS Code and
   physical-phone acceptance. Ask before changing any pre-existing test.

## Done when

- An idle instruction sent from either composer starts with the selected mode,
  model, and effort, and the displayed effective values match Codex afterward.
- Existing messages with no explicit selections behave as before.
- Active, unsupported, and uncertain cases preserve drafts and cannot cause a
  duplicate send or a silent fallback to another configuration.
- Desktop and phone delivery, receipt recovery, and installed-client smokes pass.

# HUMAN QUESTIONS

Answered by the human:

- Apply selections with the next message. No separate Apply settings action.
- Persist a successful selection for later turns in that conversation.
- If a turn is active, ask the user to wait and preserve the draft. Do not queue
  the instruction automatically.

No open questions.
