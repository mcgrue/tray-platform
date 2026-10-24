import { CodexActivityState, CodexInstance } from "../shared/codex-instances";

const icons: Record<CodexActivityState, { label: string; detail: string; path: string }> = {
  working: { label: "Working", detail: "A conversation is running.", path: "M9 6l9 6-9 6z" },
  waiting: { label: "Waiting", detail: "A conversation is waiting for input or approval.", path: "M8 7v10M16 7v10" },
  idle: { label: "Idle", detail: "All observed conversations are idle.", path: "M7 12l3 3 7-7" },
  unknown: { label: "Unknown", detail: "Current activity could not be verified.", path: "M9 9a3 3 0 016 0c0 2-3 2-3 4M12 16v.5" },
};

export function codexActivityPresentation(instance: CodexInstance, now = Date.now()) {
  const fresh = instance.activityCheckedAt !== undefined && now >= instance.activityCheckedAt && now - instance.activityCheckedAt <= 30000;
  const state = fresh && instance.activity && icons[instance.activity] ? instance.activity : "unknown";
  return { state, ...icons[state] };
}

export function codexActivityIcon(instance: CodexInstance): HTMLElement {
  return activityIcon(codexActivityPresentation(instance).state);
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
