import { AttentionBridge, AttentionItem, AttentionSnapshot, AttentionState, UrlDestination, WindowDestination } from "../shared/attention";

export function visibleAttentionItems(items: AttentionItem[], state: AttentionState): AttentionItem[] {
  return items.filter(item => item.state === state).sort((a, b) =>
    b.createdAt - a.createdAt || a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
}

export function attentionKey(item: Pick<AttentionItem, "source" | "id">): string {
  return JSON.stringify([item.source, item.id]);
}

export function urlDestination(value: string): UrlDestination {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("Enter a complete HTTP or HTTPS URL."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP and HTTPS URLs can be opened.");
  return { kind: "url", url: url.href };
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text: string, click: () => void): HTMLButtonElement {
  const node = element("button", text);
  node.type = "button";
  node.addEventListener("click", click);
  return node;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Mounts only its supplied root. Audio and other application panels remain untouched. */
export interface AttentionUIOptions {
  mountDetails?: (root: HTMLElement, item: AttentionItem) => { update(item: AttentionItem): void; dispose(): void };
}

export function mountAttentionUI(root: HTMLElement, bridge: AttentionBridge, options: AttentionUIOptions = {}): () => void {
  let disposed = false;
  let revision = 0;
  let active: AttentionState = "pending";
  let snapshot: AttentionSnapshot = { items: [] };
  const heading = element("h2", "Attention inbox");
  const status = element("p", "Loading attention inbox…");
  status.setAttribute("role", "status");
  const error = element("p");
  error.setAttribute("role", "alert");
  const tabs = element("nav");
  tabs.setAttribute("aria-label", "Attention views");
  const list = element("div");
  const empty = element("p");
  const cards = new Map<string, { node: HTMLElement; update(item: AttentionItem): void; dispose(): void }>();
  const tabButtons = new Map<AttentionState, HTMLButtonElement>();
  (["pending", "snoozed", "done"] as AttentionState[]).forEach(state => {
    const tab = button(state[0].toUpperCase() + state.slice(1), () => { active = state; render(); });
    tabButtons.set(state, tab);
    tabs.appendChild(tab);
  });
  root.append(heading, status, error, tabs, empty, list);
  root.style.maxWidth = "720px";

  function card(initial: AttentionItem) {
    let item = initial;
    const node = element("article");
    node.style.border = "1px solid #888";
    node.style.padding = "12px";
    node.style.marginTop = "10px";
    const title = element("h3");
    const metadata = element("p");
    const description = element("p");
    description.style.whiteSpace = "pre-wrap";
    const destination = element("p");
    const actions = element("div");
    const failure = element("p");
    failure.setAttribute("role", "alert");
    const editor = element("details");
    const summary = element("summary", "Choose destination");
    const form = element("form");
    const urlLabel = element("label", "Link ");
    const url = element("input");
    url.type = "url";
    url.placeholder = "https://…";
    urlLabel.appendChild(url);
    const saveURL = element("button", "Save link");
    saveURL.type = "submit";
    const windowLabel = element("label", "Window ");
    const windows = element("select");
    windowLabel.appendChild(windows);
    let choices: WindowDestination[] = [];
    let busy = false;
    async function perform(work: () => Promise<void>) {
      if (busy || disposed) return;
      busy = true;
      failure.textContent = "";
      refresh();
      try { await work(); } catch (reason) { if (!disposed) failure.textContent = errorText(reason); }
      finally { busy = false; if (!disposed) refresh(); }
    }
    const go = button("Go", () => void perform(() => bridge.goToAttention(item.source, item.id)));
    const snooze = element("select");
    snooze.setAttribute("aria-label", "Snooze duration");
    [5, 15, 60].forEach(minutes => {
      const option = element("option", `${minutes} minutes`);
      option.value = String(minutes);
      snooze.appendChild(option);
    });
    const snoozeAction = button("Snooze", () => void perform(() => bridge.setAttentionState(item.source, item.id, "snoozed", Number(snooze.value))));
    const done = button("Done", () => void perform(() => bridge.setAttentionState(item.source, item.id, "done")));
    const reopen = button("Reopen", () => void perform(() => bridge.setAttentionState(item.source, item.id, "pending")));
    const discover = button("Refresh windows", () => void perform(async () => {
      choices = await bridge.listWindows();
      if (disposed) return;
      windows.replaceChildren();
      const placeholder = element("option", choices.length ? "Choose a window…" : "No available windows");
      placeholder.value = "";
      windows.appendChild(placeholder);
      choices.forEach((choice, index) => {
        const option = element("option", choice.title || `Window ${choice.hwnd} (PID ${choice.pid})`);
        option.value = String(index);
        windows.appendChild(option);
      });
    }));
    const saveWindow = button("Save window", () => void perform(async () => {
      const selected = windows.value === "" ? undefined : choices[Number(windows.value)];
      if (!selected) throw new Error("Refresh windows and choose a destination first.");
      await bridge.setAttentionDestination(item.source, item.id, selected);
      editor.open = false;
    }));
    form.addEventListener("submit", event => {
      event.preventDefault();
      void perform(async () => {
        await bridge.setAttentionDestination(item.source, item.id, urlDestination(url.value));
        editor.open = false;
      });
    });
    form.append(urlLabel, saveURL);
    editor.append(summary, form, windowLabel, discover, saveWindow);
    actions.append(go, snooze, snoozeAction, done, reopen);
    node.append(title, metadata, description, destination, actions, editor, failure);
    const detailRoot = element("section");
    node.appendChild(detailRoot);
    const details = options.mountDetails?.(detailRoot, item);

    function refresh() {
      title.textContent = item.title;
      metadata.textContent = [item.source, item.project, new Date(item.createdAt).toLocaleString(),
        item.state === "snoozed" && item.snoozedUntil ? `Snoozed until ${new Date(item.snoozedUntil).toLocaleString()}` : ""].filter(Boolean).join(" · ");
      description.textContent = item.description || "";
      description.hidden = !item.description;
      destination.textContent = item.destination
        ? item.destination.kind === "url" ? item.destination.url : item.destination.title || `Window ${item.destination.hwnd}`
        : "No destination. Choose a window or link below.";
      go.disabled = busy || !item.destination;
      snooze.hidden = snoozeAction.hidden = item.state === "done";
      done.hidden = item.state === "done";
      reopen.hidden = item.state === "pending";
      [snooze, snoozeAction, done, reopen, discover, saveURL, saveWindow, windows, url].forEach(control => { control.disabled = busy; });
      if (!editor.open && document.activeElement !== url) url.value = item.destination?.kind === "url" ? item.destination.url : "";
    }
    refresh();
    return { node, update(next: AttentionItem) { item = next; refresh(); details?.update(item); }, dispose() { details?.dispose(); } };
  }

  function render() {
    if (disposed) return;
    const pending = snapshot.items.filter(item => item.state === "pending").length;
    heading.textContent = `Attention inbox (${pending} pending)`;
    status.textContent = "";
    error.textContent = snapshot.error || "";
    tabButtons.forEach((tab, state) => {
      tab.textContent = `${state[0].toUpperCase() + state.slice(1)} (${snapshot.items.filter(item => item.state === state).length})`;
      tab.setAttribute("aria-pressed", String(state === active));
    });
    const items = visibleAttentionItems(snapshot.items, active);
    empty.textContent = items.length ? "" : `No ${active} items.`;
    const existing = new Set(snapshot.items.map(attentionKey));
    cards.forEach((entry, key) => { if (!existing.has(key)) { entry.dispose(); entry.node.remove(); cards.delete(key); } });
    const visible = new Set(items.map(attentionKey));
    cards.forEach((entry, key) => { entry.node.hidden = !visible.has(key); });
    items.forEach((item, index) => {
      const key = attentionKey(item);
      let entry = cards.get(key);
      if (!entry) { entry = card(item); cards.set(key, entry); }
      entry.update(item);
      entry.node.hidden = false;
      const position = list.children[index];
      if (position !== entry.node) list.insertBefore(entry.node, position || null);
    });
  }

  const unsubscribe = bridge.onAttentionChanged(next => { revision++; snapshot = next; render(); });
  const unsubscribeShow = bridge.onShowAttention?.(() => {
    active = "pending";
    render();
    root.scrollIntoView({ block: "start" });
  });
  const initialRevision = revision;
  void bridge.getAttention().then(next => {
    if (disposed || revision !== initialRevision) return;
    snapshot = next;
    render();
  }).catch(reason => { if (!disposed && revision === initialRevision) { status.textContent = ""; error.textContent = errorText(reason); } });

  return () => { disposed = true; unsubscribe(); unsubscribeShow?.(); cards.forEach(entry => entry.dispose()); cards.clear(); root.replaceChildren(); };
}
