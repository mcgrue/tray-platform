import { AttentionItem, AttentionSnapshot, canNavigateAttention, codexOriginLabel, NavigationBridge, ShortcutKey, ShortcutSetting, ShortcutSnapshot } from "../shared/attention";
import { attentionKey, visibleAttentionItems } from "./attention-ui";
import { initialNavigationProgress, navigationProgressButton, navigationProgressText } from "./navigation-progress";

export function navigationItems(items: AttentionItem[], query: string): AttentionItem[] {
  const search = query.trim().toLocaleLowerCase();
  return visibleAttentionItems(items, "pending").filter(item => !search || `${item.title}\n${item.source}`.toLocaleLowerCase().includes(search));
}
export function navigationSelection(items: AttentionItem[], key: string | undefined): string | undefined {
  return items.some(item => attentionKey(item) === key) ? key : items[0] && attentionKey(items[0]);
}
export function moveNavigationSelection(items: AttentionItem[], key: string | undefined, step: number): string | undefined {
  if (!items.length) return undefined;
  const current = items.findIndex(item => attentionKey(item) === key);
  return attentionKey(items[(Math.max(0, current) + step + items.length) % items.length]);
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag); if (text !== undefined) result.textContent = text; return result;
}
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }

export interface NavigationUIOptions {
  resumeText?: (item: AttentionItem) => string;
  onResumeChanged?: (callback: () => void) => () => void;
}

export function mountNavigationUI(root: HTMLElement, bridge: NavigationBridge, options: NavigationUIOptions = {}): () => void {
  let disposed = false, attentionRevision = 0, shortcutsRevision = 0, busy = false;
  let snapshot: AttentionSnapshot = { items: [] };
  let selected: string | undefined;
  let navigatingKey: string | undefined;
  let progressButton = "Opening…";
  let previousFocus: HTMLElement | null;
  root.dataset.navigationPanel = "true";
  root.hidden = true;
  const globalError = node("p"); globalError.setAttribute("role", "alert");
  const chooser = node("section"); chooser.dataset.navigationChooser = "true"; chooser.hidden = true;
  chooser.setAttribute("aria-label", "Choose pending work");
  const heading = node("h2", "Pending work");
  const label = node("label", "Find by title or source ");
  const filter = node("input"); filter.type = "search"; label.appendChild(filter);
  filter.setAttribute("role", "combobox");
  filter.setAttribute("aria-controls", "navigation-options");
  filter.setAttribute("aria-expanded", "false");
  const list = node("div"); list.setAttribute("role", "listbox"); list.setAttribute("aria-label", "Pending items");
  list.id = "navigation-options";
  const details = node("p"); details.style.whiteSpace = "pre-wrap";
  const message = node("p"); message.setAttribute("role", "alert");
  const progress = node("p"); progress.setAttribute("role", "status");
  const go = node("button", "Go"); go.type = "button";
  go.dataset.variant = "primary";
  const close = node("button", "Close chooser"); close.type = "button";
  const settings = node("details"); settings.appendChild(node("summary", "Keyboard shortcuts"));
  const settingsError = node("p"); settingsError.setAttribute("role", "alert"); settings.appendChild(settingsError);
  const rows = new Map<ShortcutKey, { form: HTMLFormElement; input: HTMLInputElement; error: HTMLElement; setting: ShortcutSetting }>();
  chooser.append(heading, label, list, details, progress, message, go, close);
  root.append(globalError, chooser, settings);

  function hide() { root.hidden = true; chooser.hidden = true; filter.setAttribute("aria-expanded", "false"); if (previousFocus?.isConnected) previousFocus.focus(); }
  function render() {
    if (disposed) return;
    const items = navigationItems(snapshot.items, filter.value);
    selected = navigationSelection(items, selected);
    const restoreListFocus = list.contains(document.activeElement);
    list.replaceChildren();
    items.forEach((item, index) => {
      const option = node("button", `${item.title} · ${item.source}`);
      option.type = "button"; option.id = `navigation-option-${index}`;
      option.setAttribute("role", "option"); option.setAttribute("aria-selected", String(attentionKey(item) === selected));
      option.addEventListener("click", () => { selected = attentionKey(item); render(); });
      list.appendChild(option);
    });
    const item = items.find(entry => attentionKey(entry) === selected);
    filter.setAttribute("aria-activedescendant", item ? `navigation-option-${items.indexOf(item)}` : "");
    details.textContent = item ? [item.title, item.project, item.description, options.resumeText?.(item), item.origin ? codexOriginLabel(item.origin) : "", !canNavigateAttention(item) ? "Choose a destination in the attention inbox below." : ""].filter(Boolean).join("\n") : snapshot.items.some(entry => entry.state === "pending") ? "No matching pending items." : "No pending items.";
    go.disabled = busy || !canNavigateAttention(item);
    go.textContent = busy ? progressButton : "Go";
    if (restoreListFocus && !chooser.hidden) filter.focus();
  }
  async function activate() {
    if (busy) return;
    const item = navigationItems(snapshot.items, filter.value).find(entry => attentionKey(entry) === selected);
    if (!item || !canNavigateAttention(item)) return;
    busy = true; message.textContent = "";
    navigatingKey = attentionKey(item);
      const initial = initialNavigationProgress();
    progressButton = navigationProgressButton(initial);
    progress.textContent = navigationProgressText(initial);
    render();
    try { await bridge.goToPending(item.source, item.id); if (!disposed) hide(); }
    catch (error) { if (!disposed) { progress.textContent = ""; message.textContent = errorText(error); } }
    finally { busy = false; navigatingKey = undefined; render(); }
  }
  go.addEventListener("click", () => void activate()); close.addEventListener("click", hide);
  filter.addEventListener("input", () => { message.textContent = ""; render(); });
  chooser.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); hide(); }
    else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault(); selected = moveNavigationSelection(navigationItems(snapshot.items, filter.value), selected, event.key === "ArrowUp" ? -1 : 1); render();
    } else if (event.key === "Enter" && event.target !== close) { event.preventDefault(); void activate(); }
  });
  function renderSettings(next: ShortcutSnapshot) {
    if (disposed) return;
    settingsError.textContent = next.error || "";
    next.settings.forEach(setting => {
      let row = rows.get(setting.key);
      if (!row) {
        const form = node("form");
        const shortcutLabel = node("label", setting.key === "navigate" ? "Take me there shortcut " : "Capture bookmark shortcut ");
        const input = node("input"); shortcutLabel.appendChild(input);
        const save = node("button", "Save shortcut"); save.type = "submit";
        const error = node("p"); error.setAttribute("role", "status");
        row = { form, input, error, setting }; rows.set(setting.key, row);
        form.append(shortcutLabel, save, error); settings.appendChild(form);
        form.addEventListener("submit", event => {
          event.preventDefault(); save.disabled = true; error.textContent = "Saving…";
          void bridge.setShortcut(setting.key, input.value.trim()).then(() => {
            if (!disposed) return bridge.getShortcuts().then(renderSettings);
          }).catch(reason => { if (!disposed) error.textContent = errorText(reason); }).finally(() => { save.disabled = false; });
        });
      }
      const changed = row.setting.accelerator !== setting.accelerator;
      row.setting = setting;
      if (changed || !row.input.value) row.input.value = setting.accelerator;
      row.error.textContent = setting.registered ? "Registered" : `${setting.error || "Shortcut unavailable."} Use the application buttons or tray menu.`;
    });
  }
  const unsubscribers = [
    bridge.onAttentionChanged(next => { attentionRevision++; snapshot = next; render(); }),
    bridge.onShortcutsChanged(next => { shortcutsRevision++; renderSettings(next); }),
    bridge.onShowNavigation(event => {
      if (disposed) return;
      if (chooser.hidden) previousFocus = document.activeElement as HTMLElement;
      if (!busy) progress.textContent = "";
      root.hidden = false;
      chooser.hidden = false; filter.value = ""; selected = undefined; message.textContent = event.error || ""; render(); filter.focus();
      filter.setAttribute("aria-expanded", "true");
    }),
  ];
  const initialAttention = attentionRevision, initialShortcuts = shortcutsRevision;
  const unsubscribeProgress = bridge.onAttentionNavigationProgress?.(update => {
    if (disposed || !busy || attentionKey(update) !== navigatingKey) return;
    progressButton = navigationProgressButton(update);
    progress.textContent = navigationProgressText(update);
    render();
  });
  const unsubscribeResume = options.onResumeChanged?.(render);
  void bridge.getAttention().then(next => { if (!disposed && initialAttention === attentionRevision) { snapshot = next; render(); } }).catch(error => { if (!disposed) globalError.textContent = errorText(error); });
  void bridge.getShortcuts().then(next => { if (!disposed && initialShortcuts === shortcutsRevision) renderSettings(next); }).catch(error => { if (!disposed) settingsError.textContent = errorText(error); });
  return () => { disposed = true; unsubscribers.forEach(unsubscribe => unsubscribe()); unsubscribeProgress?.(); unsubscribeResume?.(); root.replaceChildren(); };
}
