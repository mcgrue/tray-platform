import { CodexTurnOptions, CodexTurnSettings, hasTurnOptions } from "../shared/codex-turn-controls";

function showChoices(select: HTMLSelectElement, choices: HTMLOptionElement[], inherited: string | null | undefined,
  override: string | undefined, fallback = "Use conversation setting") {
  const selected = override ?? inherited ?? "";
  if (selected && !choices.some(choice => choice.value === selected)) {
    const unavailable = new Option(selected, selected);
    unavailable.disabled = true;
    choices.push(unavailable);
  }
  select.replaceChildren(new Option(fallback, ""), ...choices);
  select.value = selected;
}

function overrideValue(select: HTMLSelectElement, inherited: string | null | undefined) {
  return select.value && select.value !== inherited ? select.value : undefined;
}

/** One set of controls per mounted composer; callers own draft isolation. */
export function mountCodexTurnControls(root: HTMLElement, changed: () => void, refreshSettings: () => void) {
  const group = document.createElement("details");
  group.dataset.codexTurnControls = "";
  const summary = document.createElement("summary");
  summary.textContent = "Next turn settings";
  const fields = document.createElement("div");
  fields.className = "codex-turn-fields";
  group.append(summary, fields);
  group.addEventListener("toggle", () => { if (group.open) refreshSettings(); });
  const label = (name: string) => {
    const row = document.createElement("label"); row.textContent = name;
    const select = document.createElement("select"); row.appendChild(select); fields.appendChild(row); return select;
  };
  const mode = label("Mode"), model = label("Model"), effort = label("Reasoning effort");
  const current = document.createElement("p"); current.dataset.muted = ""; group.appendChild(current);
  const warning = document.createElement("p"); warning.setAttribute("aria-live", "polite"); group.appendChild(warning);
  root.appendChild(group);
  let settings: CodexTurnSettings | undefined, draft: CodexTurnOptions = {}, busy = false;
  const selectedModel = () => draft.model || settings?.current.model;
  const selectedEffort = () => draft.effort || settings?.current.effort;
  function render() {
    const session = settings?.current;
    const models = settings?.models ?? [];
    const entry = models.find(row => row.id === selectedModel());
    showChoices(mode, [new Option("Plan", "plan"), new Option("Default", "default")], session?.mode, draft.mode);
    showChoices(model, models.map(row => new Option(row.name, row.id)), session?.model, draft.model);
    const defaultEffort = entry?.defaultEffort ? `Model default (${entry.defaultEffort})` : "Model default";
    showChoices(effort, (entry?.efforts ?? []).map(row => new Option(row.id, row.id)), session?.effort, draft.effort,
      session?.effort === null ? defaultEffort : undefined);
    const available = !!settings?.available;
    mode.disabled = busy || !available; model.disabled = busy || !available; effort.disabled = busy || !entry || !available;
    current.textContent = settings ? `Current: ${settings.current.mode || "mode unknown"} · ${settings.current.model || "model unknown"} · ${settings.current.effort === undefined ? "effort unknown" : settings.current.effort || "default effort"}`
      : "Loading Codex settings…";
    warning.textContent = !available && settings ? settings.reason || "Settings are unavailable; messages still work." : problem();
  }
  function problem(): string {
    if (!hasTurnOptions(draft)) return "";
    const entry = settings?.models.find(row => row.id === selectedModel());
    if (draft.model && !entry) return "The selected model is unavailable. Refresh settings.";
    if ((draft.mode || draft.effort) && !entry) return "Select a model before changing mode or effort.";
    if (draft.mode && selectedEffort() === undefined) return "Select a reasoning effort before changing mode.";
    if ((draft.mode || draft.model) && selectedEffort() && !entry?.efforts.some(row => row.id === selectedEffort())) {
      return "Select a reasoning effort supported by this model.";
    }
    return "";
  }
  mode.addEventListener("change", () => {
    draft.mode = overrideValue(mode, settings?.current.mode) as CodexTurnOptions["mode"];
    render(); changed();
  });
  model.addEventListener("change", () => {
    draft.model = overrideValue(model, settings?.current.model);
    draft.effort = undefined;
    render(); changed();
  });
  effort.addEventListener("change", () => {
    draft.effort = overrideValue(effort, settings?.current.effort);
    render(); changed();
  });
  render();
  return {
    setSettings(value: CodexTurnSettings | undefined) { settings = value; render(); },
    setDraft(value: CodexTurnOptions | undefined) { draft = { ...value }; render(); },
    getDraft(): CodexTurnOptions | undefined { return hasTurnOptions(draft) ? { ...draft } : undefined; },
    canSend() { return !problem() && (!hasTurnOptions(draft) || !!settings?.available); },
    setBusy(value: boolean) { busy = value; render(); },
    dispose() { root.replaceChildren(); },
  };
}
