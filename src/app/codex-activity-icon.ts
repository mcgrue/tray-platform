import { CodexActivityReason, CodexActivityState, CodexInstance } from "../shared/codex-instances";

const icons: Record<CodexActivityState, { label: string; detail: string; path: string }> = {
  working: { label: "Working", detail: "A conversation is running.", path: "M9 6l9 6-9 6z" },
  waiting: { label: "Waiting", detail: "A conversation is waiting for input or approval.", path: "M8 7v10M16 7v10" },
  idle: { label: "Idle", detail: "All observed conversations are idle.", path: "M7 12l3 3 7-7" },
  unknown: { label: "Unknown", detail: "Current activity could not be verified.", path: "M9 9a3 3 0 016 0c0 2-3 2-3 4M12 16v.5" },
};

const reasons: Record<CodexActivityReason, string> = {
  "no-conversations": "No conversations could be mapped to this process. Open a conversation in its VS Code window, then refresh.",
  "history-unavailable": "Local conversation history could not be read. Refresh to try again.",
  "incomplete-mapping": "Some conversations could not be reliably mapped to this process. Open the conversation in VS Code, then refresh.",
  "coverage-limit": "There are too many conversations to check in one pass. Activity could not be fully verified.",
  "process-unavailable": "This Codex process could not be verified as running. Refresh the instance list.",
  "connection-unavailable": "The Codex connection is unavailable. Open its VS Code window, then refresh.",
  "owner-unavailable": "The conversation's owning client is unavailable. Open the conversation in VS Code, then refresh.",
  "snapshot-timeout": "Codex did not provide an activity snapshot in time. Refresh to try again.",
  "unsupported-protocol": "Codex is using an unsupported activity protocol. Tray Platform may need an update.",
  "unsupported-state": "Codex returned an activity state this version of Tray Platform cannot interpret.",
  "state-unavailable": "Codex has not provided a usable activity state. Open the conversation in VS Code, then refresh.",
  resuming: "The conversation is still resuming. Activity will be checked again automatically.",
  "check-failed": "The activity check failed. Refresh to try again.",
};

export function codexActivityPresentation(instance: CodexInstance, now = Date.now()) {
  const fresh = instance.activityCheckedAt !== undefined && now >= instance.activityCheckedAt && now - instance.activityCheckedAt <= 30000;
  const state = fresh && instance.activity && icons[instance.activity] ? instance.activity : "unknown";
  const reason = state !== "unknown" ? undefined : instance.activityCheckedAt === undefined ? "not-checked"
    : !fresh ? "stale" : instance.activityReason;
  const detail = reason === "not-checked" ? "Activity has not been checked yet. Refresh to check now."
    : reason === "stale" ? "The last activity check is out of date. Refresh to check the current state."
    : reason && reasons[reason] || icons[state].detail;
  const last = instance.activityLastKnownAt;
  const lastConfirmed = last !== undefined && last >= 0 && last <= now && Number.isFinite(new Date(last).getTime())
    ? `Last confirmed: ${new Date(last).toLocaleString()}.` : "No confirmed activity yet.";
  return { state, ...icons[state], detail, reason, lastConfirmed };
}

export function codexActivityIcon(instance: CodexInstance): HTMLElement {
  const presentation = codexActivityPresentation(instance);
  const icon = activityIcon(presentation.state);
  icon.title = `${presentation.label}: ${presentation.detail} ${presentation.lastConfirmed}`;
  icon.setAttribute("aria-description", `${presentation.detail} ${presentation.lastConfirmed}`);
  return icon;
}

/** Visible on desktop and within the phone instance disclosure; never hover-only. */
export function mountCodexActivityDetails(root: HTMLElement, refresh: () => void) {
  root.dataset.activityDetails = "";
  const reason = document.createElement("p"), last = document.createElement("p"), button = document.createElement("button");
  reason.dataset.activityReason = ""; last.dataset.activityLastKnown = "";
  button.type = "button"; button.textContent = "Refresh now"; button.dataset.activityRefresh = "";
  button.addEventListener("click", refresh);
  root.append(reason, last, button);
  return (instance: CodexInstance, disabled: boolean) => {
    const presentation = codexActivityPresentation(instance);
    root.hidden = presentation.state !== "unknown";
    reason.textContent = presentation.detail; reason.dataset.activityReason = presentation.reason || "unavailable";
    last.textContent = presentation.lastConfirmed;
    button.disabled = disabled;
  };
}

export function codexActivityLegend(): HTMLElement {
  const legend = document.createElement("div");
  legend.className = "codex-activity-legend";
  legend.setAttribute("role", "group");
  legend.setAttribute("aria-label", "Codex activity legend");
  const title = document.createElement("span");
  title.textContent = "Activity:";
  legend.append(title);
  for (const state of Object.keys(icons) as CodexActivityState[]) {
    const item = document.createElement("span");
    const icon = activityIcon(state);
    icon.setAttribute("aria-hidden", "true");
    item.title = icon.title;
    item.append(icon, document.createTextNode(icons[state].label));
    legend.append(item);
  }
  return legend;
}

function activityIcon(state: CodexActivityState): HTMLElement {
  const { label, detail, path } = icons[state];
  const icon = document.createElement("span");
  icon.className = "codex-activity-icon";
  icon.dataset.codexActivity = state;
  icon.setAttribute("role", "img");
  icon.setAttribute("aria-label", label);
  icon.title = `${label}: ${detail}`;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const circle = document.createElementNS(svg.namespaceURI, "circle");
  circle.setAttribute("cx", "12"); circle.setAttribute("cy", "12"); circle.setAttribute("r", "10");
  const glyph = document.createElementNS(svg.namespaceURI, "path");
  glyph.setAttribute("d", path);
  svg.append(circle, glyph); icon.append(svg);
  return icon;
}
