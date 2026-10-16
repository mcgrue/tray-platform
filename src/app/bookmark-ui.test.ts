import { AttentionItem } from "../shared/attention";
import { Bookmark, BookmarkBridge, BookmarkSnapshot } from "../shared/bookmarks";
import { associatedBookmarks, bookmarkResumeText, createBookmarkUI, filterBookmarks, humanBookmarkInput, newBookmarkIdentity } from "./bookmark-ui";

function bookmark(id: string, extras: Partial<Bookmark> = {}): Bookmark {
  return { source: "robot", id, title: id, project: "Project", createdAt: 1, updatedAt: 1, ...extras };
}
const item: AttentionItem = { source: "build:a", id: "b", title: "Build", state: "done", createdAt: 1, updatedAt: 1 };

test("task association matches both identifiers safely and retains notes for Done work", () => {
  const matching = bookmark("matching", { attention: { source: "build:a", id: "b" } });
  const collision = bookmark("collision", { attention: { source: "build", id: "a:b" } });
  expect(associatedBookmarks([collision, matching, bookmark("project-only")], item)).toEqual([matching]);
});

test("project filtering handles whitespace/case, excludes unassociated projects, sorts newest and leaves input untouched", () => {
  const first = bookmark("first", { project: "Tray Platform", updatedAt: 2 });
  const newer = bookmark("newer", { project: "TRAY tools", updatedAt: 3 });
  const entries = [first, bookmark("other", { project: "Other" }), newer, bookmark("task-only", { project: undefined })];
  expect(filterBookmarks(entries, " TRAY ").map(entry => entry.id)).toEqual(["newer", "first"]);
  expect(filterBookmarks(entries, "")).toHaveLength(4);
  expect(entries[0]).toBe(first);
});

test("resume text combines human notes and robot hints, newest first without blank note noise", () => {
  const association = { source: item.source, id: item.id };
  expect(bookmarkResumeText([
    bookmark("old", { attention: association, humanNote: "Earlier note", updatedAt: 1 }),
    bookmark("new", { attention: association, humanNote: "My next step", robotHint: "Robot suggestion", updatedAt: 2 }),
    bookmark("blank", { attention: association, humanNote: "  ", robotHint: "", updatedAt: 3 }),
  ], item)).toBe("My next step\nRobot suggestion\n\nEarlier note");
});

test("human edit payload never contains a robot hint or store identity/timestamps", () => {
  const original = bookmark("robot-owned", { title: " A title ", humanNote: "Keep my whitespace\n", robotHint: "New remote hint", attention: { source: "task", id: "one" }, destination: { kind: "url", url: "https://example.com" } });
  const input = humanBookmarkInput(original);
  expect(input).toEqual({ title: "A title", project: "Project", humanNote: "Keep my whitespace\n", attention: { source: "task", id: "one" }, destination: { kind: "url", url: "https://example.com" } });
  input.attention!.id = "changed";
  expect(original.attention!.id).toBe("one");
  expect(humanBookmarkInput({ title: "Task", project: " ", humanNote: "" })).toEqual({ title: "Task", humanNote: "" });
});

test("new manual identities belong to the human and do not alias repeated captures", () => {
  const values = Array.from({ length: 50 }, () => newBookmarkIdentity());
  expect(values.every(value => value.source === "human" && value.id.length > 10)).toBe(true);
  expect(new Set(values.map(value => value.id)).size).toBe(50);
});

test("one shared subscription serves context consumers and ignores a stale initial fetch; disposal unsubscribes everything", async () => {
  let resolveInitial: (snapshot: BookmarkSnapshot) => void;
  let changed: (snapshot: BookmarkSnapshot) => void;
  const unsubscribers = [jest.fn(), jest.fn(), jest.fn()];
  const bridge = {
    getBookmarks: () => new Promise<BookmarkSnapshot>(resolve => { resolveInitial = resolve; }),
    getAttention: async () => ({ items: [item] }),
    onBookmarksChanged: jest.fn(callback => { changed = callback; return unsubscribers[0]; }),
    onAttentionChanged: jest.fn(() => unsubscribers[1]),
    onCaptureBookmark: jest.fn(() => unsubscribers[2]),
  } as unknown as BookmarkBridge;
  const ui = createBookmarkUI(bridge);
  const observer = jest.fn(); const unsubscribe = ui.onChanged(observer);
  changed!({ bookmarks: [bookmark("fresh", { attention: { source: item.source, id: item.id }, humanNote: "Current" })] });
  resolveInitial!({ bookmarks: [] });
  await Promise.resolve(); await Promise.resolve();
  expect(ui.resumeText(item)).toBe("Current");
  expect(bridge.onBookmarksChanged).toHaveBeenCalledTimes(1);
  unsubscribe(); const observed = observer.mock.calls.length;
  changed!({ bookmarks: [] }); expect(observer).toHaveBeenCalledTimes(observed);
  ui.dispose(); ui.dispose(); unsubscribers.forEach(callback => expect(callback).toHaveBeenCalledTimes(1));
});

/** A minimal DOM surface exercises component event wiring without adding a DOM runtime dependency. */
class TestElement {
  children: TestElement[] = [];
  parent?: TestElement;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  handlers = new Map<string, Array<(event: any) => void>>();
  hidden = false;
  disabled = false;
  value = "";
  textContent = "";
  constructor(public tagName: string) {}
  appendChild(child: TestElement) { this.children.push(child); child.parent = this; return child; }
  append(...children: TestElement[]) { children.forEach(child => this.appendChild(child)); }
  replaceChildren(...children: TestElement[]) { this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  addEventListener(type: string, callback: (event: any) => void) { const handlers = this.handlers.get(type) || []; handlers.push(callback); this.handlers.set(type, handlers); }
  focus() { (document as any).activeElement = this; }
  trigger(type: string) { this.handlers.get(type)?.forEach(callback => callback({ preventDefault() {} })); }
}
function descendants(root: TestElement): TestElement[] { return [root, ...root.children.flatMap(descendants)]; }
function control(root: TestElement, label: string): TestElement {
  return descendants(root).find(element => element.tagName === "label" && element.textContent.trim() === label)!.children[0];
}
function click(root: TestElement, text: string) { descendants(root).find(element => element.tagName === "button" && element.textContent === text)!.trigger("click"); }
async function flushPromises() { for (let step = 0; step < 8; step++) await Promise.resolve(); }

async function domFixture(bookmarks: Bookmark[] = []) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: (tag: string) => new TestElement(tag), activeElement: undefined } });
  let capture: (value: { error?: string }) => void;
  const bridge = {
    getBookmarks: async () => ({ bookmarks }), getAttention: async () => ({ items: [item] }),
    onBookmarksChanged: () => () => {}, onAttentionChanged: () => () => {},
    onCaptureBookmark: (callback: typeof capture) => { capture = callback; return () => {}; },
    saveBookmark: jest.fn(async () => {}), captureBookmark: jest.fn(async () => {}), goToBookmark: jest.fn(async () => {}),
  };
  const ui = createBookmarkUI(bridge as unknown as BookmarkBridge);
  const root = new TestElement("section"); ui.mount(root as unknown as HTMLElement); await flushPromises();
  return { ui, root, bridge, capture: (value: { error?: string }) => capture(value), cleanup() { ui.dispose(); if (original) Object.defineProperty(globalThis, "document", original); else Reflect.deleteProperty(globalThis, "document"); } };
}

test("fresh project bookmark clears previous task selection, and repeated New/capture preserves dirty text", async () => {
  const fixture = await domFixture([bookmark("task-note", { attention: { source: item.source, id: item.id }, humanNote: "Existing" })]);
  try {
    click(fixture.root, "Edit");
    expect(control(fixture.root, "Attention item").value).toBe(JSON.stringify([item.source, item.id]));
    click(fixture.root, "Cancel"); click(fixture.root, "New bookmark");
    expect(control(fixture.root, "Attention item").value).toBe("");
    control(fixture.root, "Project").value = "Fresh Project";
    const note = control(fixture.root, "Human note"); note.value = "Unsaved thought"; note.trigger("input");
    click(fixture.root, "New bookmark"); fixture.capture({ error: "No foreground window" });
    expect(note.value).toBe("Unsaved thought");
    expect(descendants(fixture.root).some(element => element.textContent.includes("Save or Cancel before opening"))).toBe(true);
    expect((document as any).activeElement).toBe(note);
    const form = descendants(fixture.root).find(element => element.dataset.bookmarkEditor)!;
    form.trigger("submit"); await flushPromises();
    expect(fixture.bridge.saveBookmark).toHaveBeenCalledWith("human", expect.any(String), expect.objectContaining({ project: "Fresh Project", humanNote: "Unsaved thought" }));
    expect((fixture.bridge.saveBookmark.mock.calls[0] as any[])[2]).not.toHaveProperty("attention");
    click(fixture.root, "New bookmark"); control(fixture.root, "Human note").value = "Second unsaved thought"; control(fixture.root, "Human note").trigger("input");
    click(fixture.root, "Cancel"); fixture.capture({ error: "No foreground window" });
    expect(control(fixture.root, "Human note").value).toBe("");
    expect(descendants(fixture.root).some(element => element.textContent === "No foreground window")).toBe(true);
  } finally { fixture.cleanup(); }
});

test("all editor controls lock during save and failure restores editable fields while retaining a bound task", async () => {
  const fixture = await domFixture();
  try {
    const details = new TestElement("section");
    const detailMount = fixture.ui.mountAttentionDetails(details as unknown as HTMLElement, item);
    let rejectSave: (reason: Error) => void;
    fixture.bridge.saveBookmark.mockImplementation(() => new Promise<void>((_resolve, reject) => { rejectSave = reject; }));
    click(details, "Resume note");
    const form = descendants(details).find(element => element.dataset.bookmarkEditor)!;
    control(details, "Human note").value = "Keep this after failure"; control(details, "Human note").trigger("input");
    form.trigger("submit");
    ["Title", "Project", "Attention item", "Human note"].forEach(label => expect(control(details, label).disabled).toBe(true));
    click(details, "Resume note");
    expect(control(details, "Human note").value).toBe("Keep this after failure");
    rejectSave!(new Error("Storage unavailable")); await flushPromises();
    ["Title", "Project", "Human note"].forEach(label => expect(control(details, label).disabled).toBe(false));
    expect(control(details, "Attention item").disabled).toBe(true);
    expect(form.hidden).toBe(false);
    expect(descendants(details).some(element => element.textContent === "Storage unavailable")).toBe(true);
    detailMount.dispose();
  } finally { fixture.cleanup(); }
});
