import { AttentionInput, NavigationProgress } from "../shared/attention";

export function initialNavigationProgress(item: AttentionInput): NavigationProgress {
  return { phase: item.origin && !item.destination ? "scanning" : "activating" };
}

export function navigationProgressText(progress: NavigationProgress): string {
  if (progress.phase === "scanning") return "Rescanning VS Code windows. This can take several seconds…";
  const destination = progress.destination || "destination";
  return progress.phase === "opened" ? `Opened ${destination}.` : `Opening ${destination}…`;
}

export function navigationProgressButton(progress: NavigationProgress): string {
  return progress.phase === "scanning" ? "Rescanning…" : "Opening…";
}
