import { CodexTurnOptions, CodexTurnSettings, hasTurnOptions } from "../shared/codex-turn-controls";

/** One set of controls per mounted composer; callers own draft isolation. */
export function mountCodexTurnControls(root: HTMLElement, changed: () => void) {
  const group = document.createElement("fieldset"); group.dataset.codexTurnControls = "";
  const legend = document.createElement("legend"); legend.textContent = "Next turn settings"; group.appendChild(legend);
  const label = (name: string) => {
    const row = document.createElement("label"); row.textContent = name;
    const select = document.createElement("select"); row.appendChild(select); group.appendChild(row); return select;
  };
  const mode = label("Mode"), model = label("Model"), effort = label("Reasoning effort");
  const current = document.createElement("p"); current.dataset.muted = ""; group.appendChild(current);
  const warning = document.createElement("p"); warning.setAttribute("aria-live", "polite"); group.appendChild(warning);
  root.appendChild(group);
  let settings: CodexTurnSettings | undefined, draft: CodexTurnOptions = {}, busy = false;
  const option = (value: string, text: string) => { const row = document.createElement("option"); row.value = value; row.textContent = text; return row; };
  const selectedModel = () => draft.model || settings?.current.model;
  const selectedEffort = () => draft.effort || settings?.current.effort;
  function render() {
    mode.replaceChildren(option("", "Use conversation setting"), option("plan", "Plan"), option("default", "Default"));
    mode.value = draft.mode || "";
    model.replaceChildren(option("", "Use conversation setting"), ...(settings?.models || []).map(row => option(row.id, row.name)));
    model.value = draft.model || "";
    const entry = settings?.models.find(row => row.id === selectedModel());
    effort.replaceChildren(option("", "Use conversation setting"), ...(entry?.efforts || []).map(row => option(row.id, row.id)));
    if (draft.effort && !entry?.efforts.some(row => row.id === draft.effort)) draft.effort = undefined;
    effort.value = draft.effort || "";
    const available = !!settings?.available;
    mode.disabled = busy || !available; model.disabled = busy || !available; effort.disabled = busy || !entry || !available;
    current.textContent = settings ? `Current: ${settings.current.mode || "mode unknown"} · ${settings.current.model || "model unknown"} · ${settings.current.effort === undefined ? "effort unknown" : settings.current.effort || "default effort"}`
      : "Loading Codex settings…";
    warning.textContent = !available && settings ? settings.reason || "Settings are unavailable; messages still work." : problem();
    group.hidden = false;
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
  mode.addEventListener("change", () => { draft.mode = mode.value as CodexTurnOptions["mode"] || undefined; render(); changed(); });
  model.addEventListener("change", () => { draft.model = model.value || undefined; draft.effort = undefined; render(); changed(); });
  effort.addEventListener("change", () => { draft.effort = effort.value || undefined; render(); changed(); });
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
