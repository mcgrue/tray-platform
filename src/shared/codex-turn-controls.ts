export type CodexTurnMode = "plan" | "default";
export interface CodexTurnOptions { mode?: CodexTurnMode; model?: string; effort?: string; }
export interface CodexTurnModel {
  id: string; name: string; efforts: Array<{ id: string; description: string }>;
  defaultEffort: string;
}
export interface CodexTurnCurrent { mode?: CodexTurnMode; model?: string; effort?: string | null; }
export interface CodexTurnSettings {
  models: CodexTurnModel[];
  current: CodexTurnCurrent;
  available: boolean;
  provider?: string;
  reason?: string;
}

/** The owner explicitly refused admission before starting a turn. */
export class CodexTurnNotStartedError extends Error {}

export function hasTurnOptions(value: CodexTurnOptions | undefined): boolean {
  return !!value && !!(value.mode || value.model || value.effort);
}

export function validateTurnOptions(value: unknown): CodexTurnOptions | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Codex turn settings.");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !["mode", "model", "effort"].includes(key)) ||
    (row.mode !== undefined && row.mode !== "plan" && row.mode !== "default") ||
    (row.model !== undefined && (typeof row.model !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(row.model))) ||
    (row.effort !== undefined && (typeof row.effort !== "string" || !/^[a-zA-Z0-9_-]{1,40}$/.test(row.effort)))) {
    throw new Error("Invalid Codex turn settings.");
  }
  return { ...(row.mode ? { mode: row.mode as CodexTurnMode } : {}),
    ...(row.model ? { model: row.model as string } : {}), ...(row.effort ? { effort: row.effort as string } : {}) };
}

export function resolveTurnOptions(options: CodexTurnOptions | undefined, settings: CodexTurnSettings) {
  if (!hasTurnOptions(options)) return {};
  if (!settings.available) throw new Error(settings.reason || "Codex turn settings are unavailable for this conversation.");
  const model = options!.model || settings.current.model;
  const effort = options!.effort === undefined ? settings.current.effort : options!.effort;
  const entry = settings.models.find(row => row.id === model);
  if (options!.model && !entry) throw new Error("The selected Codex model is no longer available. Refresh settings.");
  if ((options!.effort || options!.mode) && !entry) throw new Error("Select a Codex model before changing mode or effort.");
  if (options!.effort && !entry!.efforts.some(row => row.id === options!.effort)) {
    throw new Error("This reasoning effort is unavailable for the selected model. Refresh settings.");
  }
  if (options!.mode && effort === undefined) throw new Error("Select a reasoning effort before changing mode.");
  if ((options!.mode || options!.model) && effort != null && entry && !entry.efforts.some(row => row.id === effort)) {
    throw new Error("Select a reasoning effort supported by this model.");
  }
  const collaborationMode = options!.mode ? { mode: options!.mode,
    settings: { model: model!, reasoning_effort: effort!, developer_instructions: null } } : undefined;
  return { ...(options!.model ? { model: options!.model } : {}),
    ...(options!.effort ? { effort: options!.effort } : {}),
    ...(collaborationMode ? { collaborationMode } : {}) };
}
