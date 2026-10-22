import { AttentionItem, Destination } from "../shared/attention";
import { Bookmark, BookmarkBridge, BookmarkCapture, BookmarkInput, BookmarkSnapshot } from "../shared/bookmarks";

export function associatedBookmarks(bookmarks: Bookmark[], item: Pick<AttentionItem, "source" | "id">): Bookmark[] {
  return bookmarks.filter(bookmark => bookmark.attention?.source === item.source && bookmark.attention.id === item.id)
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
}

export function filterBookmarks(bookmarks: Bookmark[], project: string): Bookmark[] {
  const query = project.trim().toLocaleLowerCase();
  return bookmarks.filter(bookmark => !query || bookmark.project?.toLocaleLowerCase().includes(query))
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
}

export function bookmarkResumeText(bookmarks: Bookmark[], item: Pick<AttentionItem, "source" | "id">): string {
  return associatedBookmarks(bookmarks, item).map(bookmark => [bookmark.humanNote, bookmark.robotHint].filter(note => note?.trim()).join("\n")).filter(Boolean).join("\n\n");
}

export function newBookmarkIdentity(): { source: string; id: string } {
  const cryptoApi = globalThis.crypto as Crypto & { randomUUID?: () => string };
  return { source: "human", id: typeof cryptoApi?.randomUUID === "function" ? cryptoApi.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}` };
}

export function humanBookmarkInput(input: BookmarkInput): BookmarkInput {
  return {
    title: input.title.trim(), humanNote: input.humanNote || "",
    ...(input.project?.trim() ? { project: input.project.trim() } : {}),
    ...(input.attention ? { attention: { ...input.attention } } : {}),
    ...(input.destination ? { destination: { ...input.destination } } : {}),
  };
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag); if (text !== undefined) result.textContent = text; return result;
}
function button(text: string, click: () => void): HTMLButtonElement {
  const result = node("button", text); result.type = "button"; result.addEventListener("click", click); return result;
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function identity(item: { source: string; id: string }): string { return JSON.stringify([item.source, item.id]); }
function destinationText(destination?: Destination): string {
  return destination ? destination.kind === "url" ? destination.url : destination.title || `Window ${destination.hwnd} (PID ${destination.pid})` : "No destination captured. You can still save this note.";
}

export function createBookmarkUI(bridge: BookmarkBridge) {
  let disposed = false, revision = 0, attentionRevision = 0;
  let snapshot: BookmarkSnapshot = { bookmarks: [] };
  let attention: AttentionItem[] = [];
  const listeners = new Set<() => void>();
  const mounts = new Set<(capture: BookmarkCapture) => void>();
  const cleanups = new Set<() => void>();
  let queuedCapture: BookmarkCapture | undefined;
  const notify = () => { if (!disposed) listeners.forEach(callback => { try { callback(); } catch { /* Isolate independently mounted consumers. */ } }); };
  const subscribe = (callback: () => void) => { listeners.add(callback); return () => { listeners.delete(callback); }; };

  function editor(root: HTMLElement, saved: () => void) {
    let existing: Bookmark | undefined, task: AttentionItem | undefined, destination: Destination | undefined;
    let bookmarkIdentity = newBookmarkIdentity(), busy = false, destroyed = false, dirty = false;
    const form = node("form"); form.hidden = true;
    form.dataset.bookmarkEditor = "true";
    const heading = node("h3", "Resume note");
    const titleLabel = node("label", "Title "), title = node("input"); title.required = true; title.maxLength = 500; titleLabel.appendChild(title);
    const projectLabel = node("label", "Project "), project = node("input"); project.maxLength = 500; projectLabel.appendChild(project);
    const taskLabel = node("label", "Attention item "), tasks = node("select"); taskLabel.appendChild(tasks);
    const noteLabel = node("label", "Human note "), note = node("textarea"); note.rows = 4; note.maxLength = 20000; noteLabel.appendChild(note);
    const target = node("p"), error = node("p"); error.setAttribute("role", "alert");
    const save = node("button", "Save resume note"); save.type = "submit";
    const cancel = button("Cancel", () => { if (!busy) { dirty = false; form.hidden = true; } });
    form.append(heading, titleLabel, projectLabel, taskLabel, noteLabel, target, error, save, cancel); root.appendChild(form);
    [title, project, tasks, note].forEach(control => {
      control.addEventListener("input", () => { dirty = true; });
      control.addEventListener("change", () => { dirty = true; });
    });
    function savingControls(saving: boolean) {
      [title, project, note, save, cancel].forEach(control => { control.disabled = saving; });
      tasks.disabled = saving || Boolean(task);
    }
    function choices(selected?: { source: string; id: string }) {
      const previous = selected ? identity(selected) : tasks.value;
      tasks.replaceChildren();
      const none = node("option", "Project only"); none.value = ""; none.disabled = Boolean(existing?.attention || task); tasks.appendChild(none);
      const items = [...attention];
      if (task && !items.some(item => identity(item) === identity(task!))) items.push(task);
      items.forEach(item => { const option = node("option", `${item.title} (${item.source}; ${item.state})`); option.value = identity(item); tasks.appendChild(option); });
      if (existing?.attention && !items.some(item => identity(item) === identity(existing!.attention!))) {
        const option = node("option", `${existing.attention.source}: ${existing.attention.id}`); option.value = identity(existing.attention); tasks.appendChild(option);
      }
      tasks.value = previous || "";
    }
    tasks.addEventListener("change", () => {
      const selected = attention.find(item => identity(item) === tasks.value);
      if (selected) {
        if (!title.value || title.value === "Context bookmark") title.value = selected.title;
        if (!project.value) project.value = selected.project || "";
        if (!destination && selected.destination) { destination = selected.destination; target.textContent = destinationText(destination); }
      }
    });
    form.addEventListener("submit", event => {
      event.preventDefault(); if (busy || destroyed || disposed) return;
      if (!project.value.trim() && !tasks.value) { error.textContent = "Choose a project or attention item."; return; }
      if (existing?.project && !project.value.trim()) { error.textContent = "Enter a project name to retain or change this bookmark's project."; return; }
      const association = tasks.value ? JSON.parse(tasks.value) as [string, string] : undefined;
      const input = humanBookmarkInput({ title: title.value, project: project.value, humanNote: note.value,
        ...(association ? { attention: { source: association[0], id: association[1] } } : {}), ...(destination ? { destination } : {}) });
      busy = true; error.textContent = "Saving..."; savingControls(true);
      void bridge.saveBookmark(bookmarkIdentity.source, bookmarkIdentity.id, input).then(() => {
        if (!destroyed && !disposed) { dirty = false; form.hidden = true; error.textContent = ""; saved(); }
      }).catch(reason => { if (!destroyed && !disposed) error.textContent = errorText(reason); })
        .finally(() => { busy = false; savingControls(false); });
    });
    const unsubscribe = subscribe(() => { if (!destroyed && !form.hidden) choices(); });
    return {
      open(options: { bookmark?: Bookmark; task?: AttentionItem; capture?: BookmarkCapture } = {}) {
        if (destroyed) return;
        if (busy) { error.textContent = "Saving this resume note. Wait for saving to finish before opening another bookmark."; return; }
        if (!form.hidden && dirty) {
          error.textContent = "Unsaved resume note retained. Save or Cancel before opening another bookmark.";
          note.focus();
          return;
        }
        existing = options.bookmark; task = options.task;
        bookmarkIdentity = existing ? { source: existing.source, id: existing.id } : newBookmarkIdentity();
        destination = existing?.destination || options.capture?.destination || task?.destination;
        title.value = existing?.title || task?.title || options.capture?.destination?.title || "Context bookmark";
        project.value = existing?.project || task?.project || "";
        note.value = existing?.humanNote || "";
        tasks.value = "";
        choices(existing?.attention || task); tasks.disabled = Boolean(task);
        target.textContent = destinationText(destination); error.textContent = options.capture?.error || "";
        dirty = false; form.hidden = false; note.focus();
      },
      dispose() { destroyed = true; unsubscribe(); form.remove(); },
    };
  }

  function mount(root: HTMLElement): () => void {
    let destroyed = false;
    let actionError = "";
    root.dataset.bookmarkPanel = "true";
    const heading = node("h2", "Context bookmarks"), actions = node("div"), list = node("div");
    list.dataset.bookmarkList = "true";
    const error = node("p"); error.setAttribute("role", "alert");
    const filterLabel = node("label", "Filter by project "), filter = node("input"); filter.type = "search"; filterLabel.appendChild(filter);
    const editRoot = node("section"); const edit = editor(editRoot, () => render());
    const fresh = button("New bookmark", () => edit.open());
    const capture = button("Capture context", () => {
      capture.disabled = true;
      actionError = "";
      void bridge.captureBookmark().catch(reason => { if (!destroyed) { actionError = errorText(reason); render(); } }).finally(() => { capture.disabled = false; });
    });
    actions.append(fresh, capture); root.append(heading, actions, filterLabel, error, editRoot, list);
    function render() {
      if (destroyed || disposed) return;
      error.textContent = [snapshot.error, actionError].filter(Boolean).join("\n");
      list.replaceChildren();
      const bookmarks = filterBookmarks(snapshot.bookmarks, filter.value);
      if (!bookmarks.length) list.appendChild(node("p", "No matching bookmarks."));
      bookmarks.forEach(bookmark => {
        const card = node("article");
        card.append(node("h3", bookmark.title), node("p", [bookmark.project, bookmark.attention ? `${bookmark.attention.source}: ${bookmark.attention.id}` : ""].filter(Boolean).join(" | ")));
        if (bookmark.humanNote) { const label = node("strong", "Human note"), note = node("p", bookmark.humanNote); note.style.whiteSpace = "pre-wrap"; card.append(label, note); }
        if (bookmark.robotHint) { const label = node("strong", "Robot hint"), hint = node("p", bookmark.robotHint); hint.style.whiteSpace = "pre-wrap"; card.append(label, hint); }
        const failure = node("p"); failure.setAttribute("role", "alert");
        const go = button("Go", () => {
          go.disabled = true; failure.textContent = ""; actionError = "";
          void bridge.goToBookmark(bookmark.source, bookmark.id).catch(reason => {
            if (!destroyed) { actionError = errorText(reason); failure.textContent = actionError; error.textContent = [snapshot.error, actionError].filter(Boolean).join("\n"); }
          }).finally(() => { go.disabled = !bookmark.destination; });
        }); go.disabled = !bookmark.destination;
        card.append(node("p", destinationText(bookmark.destination)), go, button("Edit", () => edit.open({ bookmark })), failure); list.appendChild(card);
      });
    }
    filter.addEventListener("input", render);
    const unsubscribe = subscribe(render);
    const openCapture = (capture: BookmarkCapture) => edit.open({ capture }); mounts.add(openCapture);
    render(); if (queuedCapture) { const capture = queuedCapture; queuedCapture = undefined; openCapture(capture); }
    const cleanup = () => { if (destroyed) return; destroyed = true; unsubscribe(); mounts.delete(openCapture); edit.dispose(); root.replaceChildren(); cleanups.delete(cleanup); };
    cleanups.add(cleanup); return cleanup;
  }

  function mountAttentionDetails(root: HTMLElement, initial: AttentionItem) {
    let item = initial, destroyed = false;
    const notes = node("div"), editRoot = node("div"); const edit = editor(editRoot, () => render());
    const action = button("Resume note", () => edit.open({ bookmark: associatedBookmarks(snapshot.bookmarks, item)[0], task: item }));
    root.append(notes, action, editRoot);
    function render() {
      if (destroyed || disposed) return;
      notes.replaceChildren();
      associatedBookmarks(snapshot.bookmarks, item).forEach(bookmark => {
        if (bookmark.humanNote) { const label = node("strong", "Human note"), note = node("p", bookmark.humanNote); note.style.whiteSpace = "pre-wrap"; notes.append(label, note); }
        if (bookmark.robotHint) { const label = node("strong", "Robot hint"), hint = node("p", bookmark.robotHint); hint.style.whiteSpace = "pre-wrap"; notes.append(label, hint); }
      });
    }
    const unsubscribe = subscribe(render); render();
    const cleanup = () => { if (destroyed) return; destroyed = true; unsubscribe(); edit.dispose(); root.replaceChildren(); cleanups.delete(cleanup); };
    cleanups.add(cleanup);
    return { update(next: AttentionItem) { item = next; render(); }, dispose: cleanup };
  }

  const unsubscribers = [
    bridge.onBookmarksChanged(next => { revision++; snapshot = next; notify(); }),
    bridge.onAttentionChanged(next => { attentionRevision++; attention = next.items; notify(); }),
    bridge.onCaptureBookmark(capture => {
      if (disposed) return;
      const open = mounts.values().next().value as ((capture: BookmarkCapture) => void) | undefined;
      if (open) open(capture); else queuedCapture = capture;
    }),
  ];
  const initialRevision = revision, initialAttentionRevision = attentionRevision;
  void bridge.getBookmarks().then(next => { if (!disposed && revision === initialRevision) { snapshot = next; notify(); } })
    .catch(reason => { if (!disposed) { snapshot = { ...snapshot, error: errorText(reason) }; notify(); } });
  void bridge.getAttention().then(next => { if (!disposed && attentionRevision === initialAttentionRevision) { attention = next.items; notify(); } })
    .catch(reason => { if (!disposed) { snapshot = { ...snapshot, error: errorText(reason) }; notify(); } });

  return { mount, mountAttentionDetails, resumeText: (item: AttentionItem) => bookmarkResumeText(snapshot.bookmarks, item), onChanged: subscribe,
    dispose() { if (disposed) return; disposed = true; unsubscribers.forEach(unsubscribe => unsubscribe()); [...cleanups].forEach(cleanup => cleanup()); listeners.clear(); mounts.clear(); },
  };
}
