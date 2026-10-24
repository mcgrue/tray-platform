import { NavigationProgress } from "../shared/attention";

export function initialNavigationProgress(): NavigationProgress {
  // Only the main process knows whether the cached mapping needs a rescan.
  return { phase: "activating" };
}

export function navigationProgressText(progress: NavigationProgress): string {
  if (progress.phase === "scanning") return "Rescanning VS Code windows. This can take several seconds…";
  const destination = progress.destination || "destination";
  return progress.phase === "opened" ? `Opened ${destination}.` : `Opening ${destination}…`;
}

export function navigationProgressButton(progress: NavigationProgress): string {
  return progress.phase === "scanning" ? "Rescanning…" : "Opening…";
}
