import { AttentionBridge, AttentionItem, AttentionSnapshot, AttentionState, canNavigateAttention, codexOriginLabel, UrlDestination } from "../shared/attention";
import { initialNavigationProgress, navigationProgressButton, navigationProgressText } from "./navigation-progress";
import { mountCodexMessageUI } from "./codex-message-ui";
import { mountCodexQuestionUI } from "./codex-question-ui";
import { attentionContent } from "./attention-content";
import { renderAttentionMarkdown } from "./attention-markdown";
import { attentionFileHref } from "../shared/attention-link";
import { mountCodexApprovalUI } from "./codex-approval-ui";

let nextAttentionBodyId = 0;

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
  navigation?: "phone";
  requestedItem?: () => { source: string; id: string } | undefined;
  requestRevision?: () => number;
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
  const cards = new Map<string, { node: HTMLElement; expand(): void; update(item: AttentionItem): void; dispose(): void }>();
  const tabButtons = new Map<AttentionState, HTMLButtonElement>();
  let revealedKey = "";
  (["pending", "snoozed", "done"] as AttentionState[]).forEach(state => {
    const tab = button(state[0].toUpperCase() + state.slice(1), () => { active = state; render(); });
    tabButtons.set(state, tab);
    tabs.appendChild(tab);
  });
  root.append(heading, status, error, tabs, empty, list);
  root.dataset.attentionInbox = "true";

  function card(initial: AttentionItem) {
    let item = initial;
    const node = element("article");
    node.dataset.attentionKey = attentionKey(item);

    const title = element("h3");
    const phone = options.navigation === "phone";
    const titleText = phone ? element("span") : title;
    const body = phone ? element("div") : node;
    const disclosure = phone ? button("", () => setExpanded(body.hidden)) : undefined;
    function setExpanded(expanded: boolean) {
      if (!disclosure) return;
      body.hidden = !expanded; disclosure.setAttribute("aria-expanded", String(expanded));
    }
    node.appendChild(title);
    if (disclosure) {
      node.dataset.collapsibleAttention = "";
      body.dataset.attentionBody = ""; body.id = `attention-body-${++nextAttentionBodyId}`;
      disclosure.dataset.attentionDisclosure = ""; disclosure.setAttribute("aria-controls", body.id);
      titleText.dataset.attentionTitle = "";
      const chevron = element("span"); chevron.dataset.attentionChevron = ""; chevron.setAttribute("aria-hidden", "true");
      chevron.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16"><path d="m6 3 5 5-5 5"/></svg>';
      disclosure.append(titleText, chevron); title.appendChild(disclosure); node.appendChild(body);
      node.addEventListener("click", event => { if (event.target === node || event.target === title) disclosure.click(); });
      setExpanded(false);
    }
    const metadata = element("p");
    metadata.dataset.muted = "";
    const origin = element("p");
    origin.dataset.muted = "";
    const description = element("div");
    description.className = "attention-markdown";
    let renderedDescription: string | undefined;
    const destination = element("p");
    destination.dataset.muted = "";
    const actions = element("div");
    actions.dataset.cardActions = "";
    const progress = element("p");
    progress.setAttribute("role", "status");
    const failure = element("p");
    failure.setAttribute("role", "alert");
    const diagnostics = element("details");
    diagnostics.dataset.attentionDiagnostics = "";
    const diagnosticText = element("p");
    diagnostics.append(element("summary", "Details"), diagnosticText);
    let questionLoaded = false;
    let busy = false;
    let navigating = false;
    let opened = false;
    async function perform(work: () => Promise<void>) {
      if (busy || disposed) return;
      busy = true;
      failure.textContent = "";
      progress.textContent = "";
      refresh();
      try { await work(); } catch (reason) { if (!disposed) failure.textContent = errorText(reason); }
      finally { busy = false; if (!disposed) refresh(); }
    }
    const go = button("Go", () => void perform(async () => {
      navigating = true;
      opened = false;
      const initial = initialNavigationProgress();
      go.textContent = navigationProgressButton(initial);
      progress.textContent = navigationProgressText(initial);
      try {
        await bridge.goToAttention(item.source, item.id);
        if (!opened) progress.textContent = "Opened destination.";
      }
      catch (reason) { progress.textContent = ""; throw reason; }
      finally { navigating = false; go.textContent = "Go"; }
    }));
    const phoneLink = element("a", "Open link");
    phoneLink.target = "_blank"; phoneLink.rel = "noopener noreferrer";
    phoneLink.hidden = true;
    const unsubscribeProgress = bridge.onAttentionNavigationProgress?.(update => {
      if (disposed || !navigating || update.source !== item.source || update.id !== item.id) return;
      opened = update.phase === "opened";
      go.textContent = navigationProgressButton(update);
      progress.textContent = navigationProgressText(update);
    });
    go.dataset.variant = "primary";
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
    actions.append(go, phoneLink, snooze, snoozeAction, done, reopen);
    const questionRoot = element("section");
    const approvalRoot = element("section");
    body.append(metadata, origin, description, approvalRoot, questionRoot, destination, progress, failure, actions);
    const approval = mountCodexApprovalUI(approvalRoot, bridge, item);
    const markdownOptions = options.navigation === "phone" ? { localLink: (href: string) => attentionFileHref(item, href) } : {};
    const question = mountCodexQuestionUI(questionRoot, bridge, item, () => { questionLoaded = true; refresh(); }, markdownOptions);
    const messageRoot = element("section");
    body.appendChild(messageRoot);
    const message = mountCodexMessageUI(messageRoot, bridge, item, { phone: options.navigation === "phone" });
    const detailRoot = element("section");
    body.appendChild(detailRoot);
    const details = options.mountDetails?.(detailRoot, item);
    body.appendChild(diagnostics);

    function refresh() {
      const content = attentionContent(item);
      titleText.textContent = content.title;
      if (disclosure) titleText.title = content.title;
      metadata.textContent = [item.source, item.project, new Date(item.createdAt).toLocaleString(),
        item.state === "snoozed" && item.snoozedUntil ? `Snoozed until ${new Date(item.snoozedUntil).toLocaleString()}` : ""].filter(Boolean).join(" · ");
      if (renderedDescription !== content.description) {
        description.innerHTML = renderAttentionMarkdown(content.description, markdownOptions);
        renderedDescription = content.description;
      }
      description.hidden = !content.description || (questionLoaded && Boolean(content.diagnostics));
      diagnosticText.textContent = content.diagnostics;
      diagnostics.hidden = !content.diagnostics;
      origin.textContent = item.origin ? `From ${codexOriginLabel(item.origin)}` : "";
      origin.hidden = !item.origin;
      destination.textContent = item.destination
        ? item.destination.kind === "url" ? item.destination.url : item.destination.title || `Window ${item.destination.hwnd}`
        : item.origin ? "Go focuses the originating VS Code window." : "No destination.";
      go.disabled = busy || !canNavigateAttention(item);
      if (options.navigation === "phone") {
        go.hidden = true; origin.hidden = true; destination.hidden = true;
        phoneLink.hidden = item.destination?.kind !== "url";
        if (item.destination?.kind === "url") phoneLink.href = urlDestination(item.destination.url).url;
      }
      snooze.hidden = snoozeAction.hidden = item.state === "done";
      done.hidden = item.state === "done";
      reopen.hidden = item.state === "pending";
      if (item.approval) snooze.hidden = snoozeAction.hidden = done.hidden = reopen.hidden = true;
      [snooze, snoozeAction, done, reopen].forEach(control => { control.disabled = busy; });
    }
    refresh();
    return { node, expand() { setExpanded(true); }, update(next: AttentionItem) { item = next; refresh(); approval.update(item); question.update(item); message.update(item); details?.update(item); }, dispose() { unsubscribeProgress?.(); approval.dispose(); question.dispose(); message.dispose(); details?.dispose(); } };
  }

  function render() {
    if (disposed) return;
    const requested = options.requestedItem?.();
    const targetKey = requested ? attentionKey(requested) : "";
    const revealToken = `${targetKey}:${options.requestRevision?.() || 0}`;
    const target = requested && snapshot.items.find(item => attentionKey(item) === targetKey);
    const reveal = Boolean(target && revealToken !== revealedKey);
    if (reveal && target) { active = target.state; revealedKey = revealToken; }
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
    if (reveal) {
      const entry = cards.get(targetKey);
      entry?.expand(); entry?.node.scrollIntoView({ block: "start" });
    }
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
