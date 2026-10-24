// Run after yarn pre-build: electron dev-infrastructure/smoke-tweakcn-theme.cjs
// Real built renderer + CSS, with isolated bridge fixtures. No live inbox or Codex messages.
const assert = require("assert").strict;
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { app, BrowserWindow } = require("electron");
const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "tray-platform-theme-smoke-"));
app.setPath("userData", dataPath);
app.setName("Tray Platform theme smoke " + process.pid);
console.log("Theme smoke artifacts: " + dataPath);
const built = path.join(__dirname, "../dist/app");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function installFixture() {
  const now = Date.now(), listeners = new Map();
  const subscribe = name => callback => {
    const callbacks = listeners.get(name) || [];
    callbacks.push(callback); listeners.set(name, callbacks);
    return () => callbacks.splice(callbacks.indexOf(callback), 1);
  };
  const emit = (name, value) => (listeners.get(name) || []).forEach(callback => callback(value));
  const items = [
    { source: "codex", id: "theme-question", title: "Review the Tray Platform theme", project: "Tray Platform",
      description: "Project: Tray Platform\nSession: theme-session\nTurn: theme-turn\nCall: theme-call\nTool: request_user_input_async\n\nChoose the next step for the theme review.",
      state: "pending", createdAt: now, updatedAt: now, destination: { kind: "url", url: "https://example.com/review" } },
    { source: "build", id: "theme-build", title: "Renderer build completed", project: "Tray Platform",
      description: "Theme assets are bundled and ready for review.", state: "pending", createdAt: now - 60000, updatedAt: now }
  ];
  const instances = { supported: true, scanning: false, scannedAt: now, instances: [
    { codexPid: 4321, vscodePid: 1234, vscodeMainPid: 1000, title: "Tray Platform — Visual Studio Code",
      workspace: "D:\\dev\\grue\\tray-platform", workspaceKind: "folder", lastFileUpdatedAt: now },
    { codexPid: 5678, vscodePid: 2345, vscodeMainPid: 1000, title: "A deliberately long workspace title for overflow verification",
      workspace: "D:\\dev\\projects\\a-long-workspace-name\\nested-directory\\project.code-workspace", workspaceKind: "workspace" }
  ] };
  const bookmarks = [{ source: "human", id: "theme-note", title: "Continue the visual review", project: "Tray Platform",
    humanNote: "Check the inbox and question controls, then review the process table.", createdAt: now, updatedAt: now,
    destination: { kind: "url", url: "https://example.com/review" } }];
  const noop = () => {};
  window.ipcComms = {
    getTitlebar: async () => ({ title: "Tray Platform · Theme preview", platform: "win32", focused: true, maximized: false, color: "#344768", textColor: "#ffffff" }),
    titlebarAction: noop, onTitlebarChanged: subscribe("titlebar"),
    onShowAlert: subscribe("alert"), onRefreshPage: subscribe("reload"), onPlaySound: subscribe("sound"), onSayWords: subscribe("speech"),
    isDevMode: async () => false, openSoundConfig: noop,
    getAttention: async () => ({ items }), onAttentionChanged: subscribe("attention"), onShowAttention: subscribe("show"),
    onAttentionNavigationProgress: subscribe("progress"), goToAttention: async () => {}, listWindows: async () => [],
    setAttentionState: async (source, id, state) => { items.find(item => item.source === source && item.id === id).state = state; emit("attention", { items }); },
    getShortcuts: async () => ({ settings: [{ key: "navigate", accelerator: "Ctrl+Alt+Space", registered: true }] }),
    onShortcutsChanged: subscribe("shortcuts"), onShowNavigation: subscribe("navigation"),
    navigatePending: async () => emit("navigation", {}), goToPending: async () => {},
    getBookmarks: async () => ({ bookmarks }), onBookmarksChanged: subscribe("bookmarks"), onCaptureBookmark: subscribe("capture"),
    captureBookmark: async () => emit("capture", {}), saveBookmark: async () => {}, goToBookmark: async () => {},
    getCodexInstances: async () => instances, onCodexInstancesChanged: subscribe("instances"), refreshCodexInstances: async () => instances,
    getAttentionQuestion: async () => [{ index: 0, title: "Ready to continue with the Clean Slate theme?", options: ["Continue", "Review the forms"], answered: false }],
    answerAttentionQuestion: async () => ({ sessionId: "theme-session", turnId: "theme-turn", delivery: "started", remainingQuestions: 0 }),
    sendAttentionMessage: async () => ({ sessionId: "theme-session", turnId: "theme-turn", delivery: "started" })
  };
  window.showAttentionFixture = () => emit("show");
  window.alert = message => { throw new Error(message); };
}

let win;
async function run() {
  await app.whenReady();
  const html = fs.readFileSync(path.join(built, "index.html"), "utf8")
    .replace('<script src="./index.js"></script>', "")
    .replace('href="./index.css"', 'href="' + pathToFileURL(path.join(built, "index.css")).href + '"')
    .replace('src="../main/resources/tray-icon.png"', 'src="' + pathToFileURL(path.join(built, "../main/resources/tray-icon.png")).href + '"');
  const fixture = path.join(dataPath, "preview.html");
  fs.writeFileSync(fixture, html);
  win = new BrowserWindow({ width: 920, height: 760, show: false, frame: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.setAudioMuted(true);
  const errors = [], remoteRequests = [];
  win.webContents.on("console-message", (_event, level, message) => { if (level >= 3) errors.push(message); });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => {
    remoteRequests.push(details.url); callback({ cancel: true });
  });
  const evaluate = (fn, ...args) => win.webContents.executeJavaScript("(" + fn.toString() + ")(..." + JSON.stringify(args) + ")");
  const tab = id => evaluate(value => document.getElementById("tab-" + value).click(), id);
  const selectedTab = () => evaluate(() => document.querySelector('#section-tabs [aria-selected="true"]').getAttribute("aria-controls"));
  const capture = async name => {
    await sleep(180); // Allow CSS transitions and the compositor to finish before visual review.
    fs.writeFileSync(path.join(dataPath, name), (await win.webContents.capturePage()).toPNG());
  };
  const waitFor = async (description, fn) => {
    for (let attempt = 0; attempt < 100; attempt++) { if (await evaluate(fn)) return; await sleep(40); }
    throw new Error("Timed out: " + description);
  };
  await win.loadFile(fixture);
  win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evaluate(installFixture);
  await win.webContents.executeJavaScript(fs.readFileSync(path.join(built, "index.js"), "utf8"));
  await waitFor("all renderer panels", () => document.querySelectorAll("main article").length === 2 && document.querySelectorAll("tbody tr").length === 2);
  const baseline = await evaluate(() => ({
    background: getComputedStyle(document.documentElement).backgroundColor,
    card: getComputedStyle(document.querySelector("article")).backgroundColor,
    primary: getComputedStyle(document.querySelector("[data-variant=primary]")).backgroundColor,
    titlebarHeight: document.getElementById("app-titlebar").getBoundingClientRect().height,
    hiddenLeaks: [...document.querySelectorAll("[hidden]")].filter(node => getComputedStyle(node).display !== "none").length,
    overflow: document.documentElement.scrollWidth > innerWidth,
    navigationHidden: getComputedStyle(document.querySelector("#navigation")).display === "none",
    hasLauncher: !!document.querySelector("#navigation > button"),
    inboxTop: document.querySelector("main").getBoundingClientRect().top,
    tabsBottom: document.getElementById("section-tabs").getBoundingClientRect().bottom,
    tabs: [...document.querySelectorAll('#section-tabs [role="tab"]')].map(button => ({
      label: button.textContent, selected: button.getAttribute("aria-selected"), tabIndex: button.tabIndex,
      linked: document.getElementById(button.getAttribute("aria-controls")).getAttribute("aria-labelledby") === button.id
    })),
    visiblePanels: [...document.querySelectorAll('[role="tabpanel"]')].filter(panel => !panel.hidden).map(panel => panel.id),
    stylesheets: [...document.styleSheets].map(sheet => sheet.href)
  }));
  assert.equal(baseline.background, "rgb(15, 24, 43)", "Electron 19 uses the sRGB theme fallback");
  assert.equal(baseline.card, "rgb(29, 41, 61)");
  assert.equal(baseline.primary, "rgb(129, 140, 249)");
  assert.equal(baseline.titlebarHeight, 36);
  assert.equal(baseline.hiddenLeaks, 0);
  assert.equal(baseline.overflow, false);
  assert.equal(baseline.navigationHidden, true, "Navigation section is absent from the initial layout");
  assert.equal(baseline.hasLauncher, false, "Take me there launcher is removed");
  assert(baseline.inboxTop >= baseline.tabsBottom && baseline.inboxTop - baseline.tabsBottom <= 28, "Inbox starts below the tab bar without a navigation gap");
  assert.deepEqual(baseline.tabs.map(button => button.label), ["Attention Inbox", "Codex Instances", "Context Bookmarks", "Sound Board"]);
  assert.deepEqual(baseline.tabs.map(button => button.selected), ["true", "false", "false", "false"]);
  assert.deepEqual(baseline.tabs.map(button => button.tabIndex), [0, -1, -1, -1]);
  assert(baseline.tabs.every(button => button.linked), "Tabs and panels have accessible labels and controls");
  assert.deepEqual(baseline.visiblePanels, ["attention-inbox"]);
  assert(baseline.stylesheets.some(href => href && href.endsWith("/index.css")), "Built CSS loaded from the HTML link");
  await sleep(120);
  await capture("inbox.png");

  for (const [key, expected] of [["ArrowRight", "codex-instances"], ["End", "soundboard"], ["ArrowRight", "attention-inbox"], ["ArrowLeft", "soundboard"], ["Home", "attention-inbox"]]) {
    await evaluate(value => document.querySelector('#section-tabs [aria-selected="true"]').dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })), key);
    assert.equal(await selectedTab(), expected, "Tab keyboard navigation: " + key);
    assert.equal(await evaluate(() => document.activeElement.getAttribute("aria-controls")), expected, "Keyboard selection also moves focus");
  }

  // Programmatic focus keeps this hidden fixture from stealing desktop focus.
  // Chromium starts in keyboard modality, so :focus-visible must still apply.
  await evaluate(() => document.querySelector("main nav button").focus());
  await sleep(60);
  assert(await evaluate(() => document.activeElement.matches("button") && getComputedStyle(document.activeElement).outlineStyle === "solid"), "Keyboard focus has a visible ring");
  assert.equal(await evaluate(() => document.querySelector("[data-codex-question]").open), true, "Questions start expanded");
  await waitFor("question fields", () => !!document.querySelector("textarea[data-question-index]"));
  await evaluate(() => {
    const input = document.querySelector("textarea[data-question-index]");
    input.value = "Continue"; input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.equal(await evaluate(() => document.querySelector("textarea[data-question-index]").value), "Continue");
  assert.equal(await evaluate(() => document.querySelector("[data-submit-answer]").disabled), false);
  await tab("codex-instances");
  await tab("attention-inbox");
  assert.equal(await evaluate(() => document.querySelector("textarea[data-question-index]").value), "Continue", "Switching tabs preserves a question draft");
  assert.equal(await evaluate(() => document.querySelector("[data-codex-question]").open), true, "Question editor stays open across tab switches");
  const savedScroll = await evaluate(() => { window.scrollTo(0, 300); return window.scrollY; });
  assert(savedScroll > 0);
  await tab("soundboard");
  await tab("attention-inbox");
  assert.equal(await evaluate(() => window.scrollY), savedScroll, "Tab switches restore the panel's scroll position");
  assert(await evaluate(() => {
    const field = document.querySelector("textarea[data-question-index]").getBoundingClientRect();
    const card = document.querySelector("main article").getBoundingClientRect();
    return field.width > 400 && field.right <= card.right && field.left >= card.left;
  }), "Question textarea fills its form without overflowing");
  await capture("question.png");

  await tab("soundboard");
  await evaluate(() => {
    void window.ipcComms.navigatePending();
    document.querySelector("[data-codex-question]").open = false;
  });
  await waitFor("chooser opens", () => !document.querySelector("[data-navigation-chooser]").hidden);
  assert.equal(await selectedTab(), "attention-inbox", "Navigation shortcuts reveal the Inbox tab");
  await evaluate(() => document.querySelector("[data-navigation-chooser]").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(await evaluate(() => getComputedStyle(document.querySelector("[data-navigation-chooser]")).display), "none");
  assert.equal(await evaluate(() => getComputedStyle(document.querySelector("#navigation")).display), "none", "Closing the chooser removes the entire section again");
  await evaluate(() => document.querySelector("main nav button:nth-child(3)").click());
  assert.equal(await evaluate(() => [...document.querySelectorAll("main article")].filter(node => getComputedStyle(node).display !== "none").length), 0, "Done tab hides pending cards");
  await evaluate(() => document.querySelector("main nav button").click());

  await tab("codex-instances");
  await sleep(80);
  await capture("processes.png");
  await evaluate(() => document.querySelector('[data-sort-column="codexPid"]').click());
  await tab("bookmarks");
  await evaluate(() => document.querySelector("#bookmarks button").click());
  assert.equal(await evaluate(() => getComputedStyle(document.querySelector("#bookmarks [data-bookmark-editor]")).display), "block");
  await evaluate(() => {
    const field = document.querySelector("#bookmarks [data-bookmark-editor] textarea");
    field.value = "Keep this unfinished resume note";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    const filter = document.querySelector('#bookmarks input[type="search"]');
    filter.value = "Tray"; filter.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await tab("codex-instances");
  assert.equal(await evaluate(() => document.querySelector('[data-sort-column="codexPid"]').parentElement.getAttribute("aria-sort")), "ascending", "Table sort survives a tab switch");
  await tab("bookmarks");
  assert.equal(await evaluate(() => document.querySelector("#bookmarks [data-bookmark-editor] textarea").value), "Keep this unfinished resume note", "Bookmark draft survives a tab switch");
  assert.equal(await evaluate(() => document.querySelector('#bookmarks input[type="search"]').value), "Tray", "Bookmark filter survives a tab switch");
  await capture("bookmark-form.png");
  await tab("soundboard");
  assert(await evaluate(() => document.querySelectorAll("#soundboard audio").length > 0), "Soundboard stays mounted");
  await capture("soundboard.png");
  await evaluate(() => window.showAttentionFixture());
  assert.equal(await selectedTab(), "attention-inbox", "Show Attention reveals the Inbox tab");
  await tab("soundboard");
  await evaluate(() => window.ipcComms.captureBookmark());
  assert.equal(await selectedTab(), "bookmarks", "Capture bookmark reveals its tab");
  assert(await evaluate(() => document.querySelector("#bookmarks [data-bookmark-editor] textarea") === document.activeElement), "Capture focuses the visible bookmark editor");
  await tab("codex-instances");
  win.setSize(480, 760);
  await sleep(100);
  assert(await evaluate(() => {
    const scroller = document.querySelector("[data-table-scroll]");
    return document.documentElement.scrollWidth <= innerWidth && scroller.scrollWidth > scroller.clientWidth && getComputedStyle(scroller).overflowX === "auto";
  }), "Narrow windows keep table overflow inside its scroller");
  assert(await evaluate(() => {
    const tabs = document.getElementById("section-tabs");
    return tabs.scrollWidth > tabs.clientWidth && getComputedStyle(tabs).overflowX === "auto";
  }), "Narrow windows scroll the tab bar without overflowing the page");
  await capture("narrow-processes.png");
  await tab("attention-inbox");
  await evaluate(() => window.scrollTo(0, 0));
  assert(await evaluate(() => {
    const active = document.querySelector('#section-tabs [aria-selected="true"]').getBoundingClientRect();
    const tabs = document.getElementById("section-tabs").getBoundingClientRect();
    return active.left >= tabs.left && active.right <= tabs.right;
  }), "Selected tab stays visible in the narrow tab bar");
  await capture("narrow.png");
  assert.deepEqual(errors, [], "Renderer reports no errors");
  assert.deepEqual(remoteRequests, [], "Theme stays entirely local");
  console.log("PASS: built theme, Electron " + process.versions.electron + " colors, tab order/default/keyboard controls, retained drafts/filter/sort, shortcut routing, forms, and narrow overflow");
  console.log("Screenshots and isolated profile retained at: " + dataPath);
}

const watchdog = setTimeout(() => { console.error("Theme smoke timed out"); app.exit(1); }, 30000);
run().then(() => { clearTimeout(watchdog); app.exit(0); })
  .catch(error => { console.error(error); clearTimeout(watchdog); app.exit(1); });

