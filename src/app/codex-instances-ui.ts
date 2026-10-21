import { CodexInstancesBridge, CodexInstancesSnapshot } from "../shared/codex-instances";

export function mountCodexInstancesUI(root: HTMLElement, bridge: CodexInstancesBridge): () => void {
  let disposed = false;
  let revision = 0;
  const heading = document.createElement("h2");
  heading.textContent = "VS Code Codex instances";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = "Loading Codex instances…";
  const error = document.createElement("p");
  error.setAttribute("role", "alert");
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.textContent = "Refresh now";
  const scroller = document.createElement("div");
  scroller.style.overflowX = "auto";
  const table = document.createElement("table");
  table.setAttribute("aria-label", "VS Code Codex processes");
  table.style.width = "100%";
  table.style.borderCollapse = "collapse";
  const head = table.createTHead().insertRow();
  ["VS Code window", "Folder / workspace", "VS Code PID", "Codex PID"].forEach(label => {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    cell.style.textAlign = "left";
    cell.style.padding = "8px";
    if (label === "VS Code PID") cell.title = "The Code.exe extension host that owns the Codex process";
    head.appendChild(cell);
  });
  const body = table.createTBody();
  scroller.appendChild(table);
  const empty = document.createElement("p");
  root.style.borderTop = "1px solid #344158";
  root.style.marginTop = "24px";
  root.style.paddingTop = "12px";
  root.append(heading, status, error, refresh, empty, scroller);

  function render(snapshot: CodexInstancesSnapshot): void {
    if (disposed) return;
    heading.textContent = `VS Code Codex instances (${snapshot.instances.length})`;
    status.textContent = !snapshot.supported ? "Process discovery is available on Windows."
      : snapshot.scanning ? "Scanning VS Code processes…"
      : `${snapshot.scannedAt ? `Last scanned ${new Date(snapshot.scannedAt).toLocaleTimeString()}. ` : ""}Scans every 5 minutes.`;
    error.textContent = [snapshot.error ? `Scan failed: ${snapshot.error}${snapshot.scannedAt ? " Showing the last successful scan." : ""}` : "", snapshot.warning].filter(Boolean).join(" ");
    refresh.disabled = snapshot.scanning || !snapshot.supported;
    empty.textContent = !snapshot.instances.length && snapshot.supported && !snapshot.scanning && !snapshot.error
      ? "No Codex processes found under VS Code." : "";
    table.hidden = !snapshot.instances.length;
    body.replaceChildren();
    snapshot.instances.forEach(instance => {
      const row = body.insertRow();
      row.dataset.codexPid = String(instance.codexPid);
      [instance.title || "Window title unavailable", instance.workspace || "Folder unavailable", String(instance.vscodePid), String(instance.codexPid)].forEach((value, index) => {
        const cell = row.insertCell();
        cell.textContent = value;
        cell.style.padding = "10px 8px";
        cell.style.verticalAlign = "top";
        cell.style.borderTop = "1px solid #344158";
        if (index < 2) { cell.style.overflowWrap = "anywhere"; cell.style.minWidth = "150px"; }
        if (index === 1 && instance.workspaceKind === "workspace") cell.title = "VS Code workspace file";
        if (index === 2) cell.title = `Extension host PID ${instance.vscodePid}; main VS Code PID ${instance.vscodeMainPid}${instance.windowPid ? `; window renderer PID ${instance.windowPid}` : ""}`;
      });
    });
  }

  const unsubscribe = bridge.onCodexInstancesChanged(snapshot => { revision++; render(snapshot); });
  const initialRevision = revision;
  void bridge.getCodexInstances().then(snapshot => { if (revision === initialRevision) render(snapshot); })
    .catch(reason => { if (!disposed && revision === initialRevision) error.textContent = String(reason); });
  refresh.addEventListener("click", () => {
    refresh.disabled = true;
    void bridge.refreshCodexInstances().catch(reason => {
      if (!disposed) { error.textContent = String(reason); refresh.disabled = false; }
    });
  });
  return () => { disposed = true; unsubscribe(); root.replaceChildren(); };
}
