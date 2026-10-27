import { CodexInstance, CodexInstancesBridge, CodexInstancesSnapshot } from "../shared/codex-instances";
import { codexActivityIcon, codexActivityLegend } from "./codex-activity-icon";
import { mountCodexInstanceComposer } from "./codex-instance-composer";
import { mountCodexInstanceMenu } from "./codex-instance-menu";

export type CodexSortColumn = "title" | "workspace" | "vscodePid" | "codexPid" | "lastFileUpdatedAt";
export type CodexSortDirection = "ascending" | "descending";
let nextInstanceViewId = 0;

export function sortCodexInstances(instances: readonly CodexInstance[], column: CodexSortColumn, direction: CodexSortDirection): CodexInstance[] {
  return [...instances].sort((a, b) => {
    const left = a[column], right = b[column];
    const missing = (value: string | number | undefined) => value === undefined || value === "" || (typeof value === "number" && !Number.isFinite(value));
    if (missing(left) !== missing(right)) return missing(left) ? 1 : -1;
    const compared = missing(left) ? 0 : typeof left === "number" && typeof right === "number"
      ? left - right : String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
    return compared * (direction === "ascending" ? 1 : -1) || a.codexPid - b.codexPid;
  });
}

export function mountCodexInstancesUI(root: HTMLElement, bridge: CodexInstancesBridge, options: { phone?: boolean } = {}): () => void {
  if (options.phone) root.dataset.phoneInstances = "";
  const viewId = ++nextInstanceViewId;
  const expanded = new Set<string>();
  let disposed = false;
  let revision = 0;
  let latest: CodexInstancesSnapshot | undefined;
  let sortColumn: CodexSortColumn = "title";
  let sortDirection: CodexSortDirection = "ascending";
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
  scroller.dataset.tableScroll = "";
  const table = document.createElement("table");
  table.setAttribute("aria-label", "VS Code Codex processes");

  const head = table.createTHead().insertRow();
  const columns: Array<{ key: CodexSortColumn; label: string }> = [
    { key: "title", label: "VS Code window" }, { key: "workspace", label: "Folder / workspace" },
    { key: "vscodePid", label: "VS Code PID" }, { key: "codexPid", label: "Codex PID" },
    { key: "lastFileUpdatedAt", label: "Last file update" },
  ];
  const headers = columns.map(({ key, label }) => {
    const cell = document.createElement("th");
    cell.scope = "col";
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.sortColumn = key;
    button.textContent = `${label} ↕`;

    button.addEventListener("click", () => {
      sortDirection = sortColumn === key && sortDirection === "ascending" ? "descending" : "ascending";
      sortColumn = key;
      if (latest) render(latest);
    });
    cell.appendChild(button);

    if (label === "VS Code PID") cell.title = "The Code.exe extension host that owns the Codex process";
    if (key === "lastFileUpdatedAt") cell.title = "Latest successful file edit recorded for this Codex process. Shell-script writes are not included. Checked on each scan.";
    head.appendChild(cell);
    return { cell, button, key, label };
  });
  const body = table.createTBody();
  const sortLabel = document.createElement("label"); sortLabel.dataset.instanceSort = ""; sortLabel.textContent = "Sort instances";
  const sort = document.createElement("select");
  for (const column of columns) for (const direction of ["ascending", "descending"] as const) {
    const option = document.createElement("option"); option.value = `${column.key}:${direction}`;
    option.textContent = `${column.label} (${direction})`; sort.appendChild(option);
  }
  sort.addEventListener("change", () => {
    const [column, direction] = sort.value.split(":"); sortColumn = column as CodexSortColumn; sortDirection = direction as CodexSortDirection;
    if (latest) render(latest);
  });
  sortLabel.appendChild(sort);
  const messaging = !!bridge.getCodexInstanceConversations && !!bridge.sendCodexInstanceMessage;
  const composerRoot = document.createElement("section");
  const composer = mountCodexInstanceComposer(composerRoot, bridge, options);
  scroller.appendChild(table);
  const empty = document.createElement("p");

  root.append(heading, codexActivityLegend(), status, error, refresh, composerRoot, empty, scroller);
  if (options.phone) scroller.before(sortLabel);
  const menu = messaging ? mountCodexInstanceMenu(root, instance => composer.open(instance)) : undefined;
  if (menu) {
    const actions = document.createElement("th"); actions.scope = "col";
    actions.setAttribute("aria-label", "Actions"); actions.dataset.instanceActions = ""; head.appendChild(actions);
  }

  function render(snapshot: CodexInstancesSnapshot): void {
    if (disposed) return;
    latest = snapshot;
    sort.value = `${sortColumn}:${sortDirection}`;
    composer.update(snapshot);
    headers.forEach(({ cell, button, key, label }) => {
      const active = key === sortColumn;
      cell.setAttribute("aria-sort", active ? sortDirection : "none");
      button.textContent = `${label} ${active ? sortDirection === "ascending" ? "↑" : "↓" : "↕"}`;
      button.setAttribute("aria-label", `${label}: sort ${active && sortDirection === "ascending" ? "descending" : "ascending"}`);
    });
    heading.textContent = `VS Code Codex instances (${snapshot.instances.length})`;
    status.textContent = !snapshot.supported ? "Process discovery is available on Windows."
      : snapshot.scanning ? "Scanning VS Code processes…"
      : `${snapshot.scannedAt ? `Last scanned ${new Date(snapshot.scannedAt).toLocaleTimeString()}. ` : ""}Scans every 5 minutes. Activity checks every 10 seconds.`;
    error.textContent = [snapshot.error ? `Scan failed: ${snapshot.error}${snapshot.scannedAt ? " Showing the last successful scan." : ""}` : "", snapshot.warning].filter(Boolean).join(" ");
    refresh.disabled = snapshot.scanning || !snapshot.supported;
    empty.textContent = !snapshot.instances.length && snapshot.supported && !snapshot.scanning && !snapshot.error
      ? "No Codex processes found under VS Code." : "";
    table.hidden = !snapshot.instances.length;
    scroller.hidden = table.hidden;
    const focusedDisclosure = (document.activeElement as HTMLElement | null)?.dataset.instanceDisclosure;
    let restoreDisclosureFocus: HTMLButtonElement | undefined;
    body.replaceChildren();
    sortCodexInstances(snapshot.instances, sortColumn, sortDirection).forEach(instance => {
      const row = body.insertRow();
      row.dataset.codexPid = String(instance.codexPid);
      const identity = JSON.stringify([instance.codexPid, instance.codexStartedAt]);
      const updated = instance.lastFileUpdatedAt;
      const updatedText = updated !== undefined && Number.isFinite(updated) ? new Date(updated).toLocaleString() : "Unavailable";
      [instance.title || "Window title unavailable", instance.workspace || "Folder unavailable", String(instance.vscodePid), String(instance.codexPid), updatedText].forEach((value, index) => {
        const cell = row.insertCell();
        cell.dataset.label = columns[index].label;
        cell.textContent = value;
        if (index === 0) cell.prepend(codexActivityIcon(instance));

        if (index < 2) { cell.style.overflowWrap = "anywhere"; cell.style.minWidth = "150px"; }
        if (index === 1 && instance.workspaceKind === "workspace") cell.title = "VS Code workspace file";
        if (index === 2) cell.title = `Extension host PID ${instance.vscodePid}; main VS Code PID ${instance.vscodeMainPid}${instance.windowPid ? `; window renderer PID ${instance.windowPid}` : ""}`;
        if (index === 4) {
          cell.style.minWidth = "155px";
          if (updatedText === "Unavailable") cell.title = "No confirmed file edit found for this Codex process, or its edit history is unavailable.";
        }
      });
      if (options.phone) {
        const details = Array.from(row.cells).slice(1);
        const disclosure = document.createElement("button");
        disclosure.type = "button"; disclosure.dataset.instanceDisclosure = identity;
        const title = document.createElement("span"); title.dataset.instanceTitle = "";
        title.textContent = instance.title || "Window title unavailable"; title.title = title.textContent;
        const chevron = document.createElement("span"); chevron.dataset.instanceChevron = "";
        chevron.setAttribute("aria-hidden", "true");
        chevron.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16"><path d="m6 3 5 5-5 5"/></svg>';
        disclosure.append(row.cells[0].querySelector("[data-codex-activity]")!, title, chevron);
        row.cells[0].replaceChildren(disclosure);
        details.forEach((cell, index) => { cell.id = `instance-${viewId}-${instance.codexPid}-detail-${index}`; });
        disclosure.setAttribute("aria-controls", details.map(cell => cell.id).join(" "));
        const updateExpanded = () => {
          const open = expanded.has(identity);
          disclosure.setAttribute("aria-expanded", String(open));
          details.forEach(cell => { cell.hidden = !open; });
        };
        disclosure.addEventListener("click", () => {
          if (expanded.has(identity)) expanded.delete(identity); else expanded.add(identity);
          updateExpanded();
        });
        row.addEventListener("click", event => {
          if (event.target === row || event.target === row.cells[0]) disclosure.click();
        });
        updateExpanded();
        if (focusedDisclosure === identity) restoreDisclosureFocus = disclosure;
      }
      if (menu) {
        const cell = row.insertCell(); cell.dataset.instanceActions = "";
        cell.appendChild(menu.trigger(instance));
      }
    });
    restoreDisclosureFocus?.focus({ preventScroll: true });
    menu?.update();
  }

  const unsubscribe = bridge.onCodexInstancesChanged(snapshot => { revision++; render(snapshot); });
  // Expire a last-known indicator even if its producer stops publishing.
  const activityExpiry = setInterval(() => {
    if (!latest || disposed) return;
    for (const row of Array.from(body.rows)) {
      const instance = latest.instances.find(item => String(item.codexPid) === row.dataset.codexPid);
      if (instance) row.querySelector("[data-codex-activity]")?.replaceWith(codexActivityIcon(instance));
    }
  }, 5000);
  const initialRevision = revision;
  void bridge.getCodexInstances().then(snapshot => { if (revision === initialRevision) render(snapshot); })
    .catch(reason => { if (!disposed && revision === initialRevision) error.textContent = String(reason); });
  refresh.addEventListener("click", () => {
    refresh.disabled = true;
    void bridge.refreshCodexInstances().catch(reason => {
      if (!disposed) { error.textContent = String(reason); refresh.disabled = false; }
    });
  });
  return () => { disposed = true; clearInterval(activityExpiry); unsubscribe(); menu?.dispose(); composer.dispose(); root.replaceChildren(); };
}
