import vm from "vm";
import fs from "fs";
import path from "path";

const origin = "https://fixture.ts.net";
const target = `${origin}/#item=fixture`;

function worker() {
  const handlers: Record<string, (event: any) => void> = {};
  const channels: any[] = [];
  class Channel {
    port1 = { onmessage: undefined as undefined | ((event: any) => void), close: jest.fn() };
    port2 = { postMessage: (data: any) => this.port1.onmessage?.({ data }), close: jest.fn() };
    constructor() { channels.push(this); }
  }
  const matchAll = jest.fn(async (): Promise<any[]> => []), openWindow = jest.fn(async (): Promise<any> => null);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "sw.js"), "utf8"), {
    URL, MessageChannel: Channel, setTimeout, clearTimeout,
    self: { location: { origin }, addEventListener: (name: string, handler: any) => handlers[name] = handler, clients: { matchAll, openWindow } },
  });
  const click = (url = target) => {
    let work = Promise.resolve();
    handlers.notificationclick({ notification: { close: jest.fn(), data: { url } }, waitUntil: (value: Promise<void>) => work = value });
    return work;
  };
  return { matchAll, openWindow, click, channels };
}

function pane(standalone?: boolean, url = origin + "/") {
  return { url, frameType: "top-level", navigate: jest.fn(), focus: jest.fn(async () => {}),
    postMessage: jest.fn((message: any, ports?: any[]) => {
      if (message.type === "attention-client-info" && standalone !== undefined) ports?.[0].postMessage({ type: "attention-client-info", standalone });
    }) };
}

test("notification clicks prefer a standalone PWA over the more recent browser tab, preserving both drafts", async () => {
  const { matchAll, openWindow, click, channels } = worker();
  const tab = pane(false), app = pane(true);
  matchAll.mockResolvedValue([tab, app]);
  await click();
  expect(app.focus).toHaveBeenCalledTimes(1);
  expect(app.postMessage).toHaveBeenCalledWith({ type: "attention-open", url: target });
  expect(tab.focus).not.toHaveBeenCalled();
  expect(tab.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "attention-open" }));
  expect(app.navigate).not.toHaveBeenCalled(); expect(tab.navigate).not.toHaveBeenCalled();
  expect(openWindow).not.toHaveBeenCalled();
  expect(channels.every(channel => channel.port1.close.mock.calls.length === 1 && channel.port2.close.mock.calls.length === 1)).toBe(true);
});

test("a suspended or older pane cannot indefinitely delay notification clicks", async () => {
  const { matchAll, click, channels } = worker();
  const suspended = pane(), app = pane(true);
  matchAll.mockResolvedValue([suspended, app]);
  await click();
  expect(app.focus).toHaveBeenCalled(); expect(suspended.focus).not.toHaveBeenCalled();
  expect(channels.every(channel => channel.port1.close.mock.calls.length === 1)).toBe(true);
});

test("a PWA that closes during selection falls back to the remaining browser pane", async () => {
  const { matchAll, click, openWindow } = worker();
  const tab = pane(false), app = pane(true);
  app.focus.mockRejectedValue(new Error("Window closed"));
  matchAll.mockResolvedValue([tab, app]);
  await click();
  expect(tab.focus).toHaveBeenCalled();
  expect(tab.postMessage).toHaveBeenCalledWith({ type: "attention-open", url: target });
  expect(openWindow).not.toHaveBeenCalled();
});

test("an unavailable pane opens the exact notification URL and focuses the new window", async () => {
  const { matchAll, click, openWindow } = worker();
  const closed = pane(), opened = pane();
  closed.focus.mockRejectedValue(new Error("Window closed"));
  matchAll.mockResolvedValue([closed]); openWindow.mockResolvedValue(opened);
  await click();
  expect(openWindow).toHaveBeenCalledWith(target); expect(opened.focus).toHaveBeenCalled();
});

test("notification clicks do not focus an offline page, unrelated origin, or embedded pane", async () => {
  const { matchAll, click, openWindow } = worker();
  const offline = pane(false, origin + "/offline.html"), unrelated = pane(false, "https://other.test/"), embedded = pane(false);
  embedded.frameType = "nested";
  matchAll.mockResolvedValue([offline, unrelated, embedded]);
  await click();
  expect(openWindow).toHaveBeenCalledWith(target);
  for (const client of [offline, unrelated, embedded]) expect(client.focus).not.toHaveBeenCalled();
});

test("click routing retains browser order when neither pane is standalone", async () => {
  const { matchAll, click } = worker();
  const first = pane(false), second = pane(false);
  matchAll.mockResolvedValue([first, second]);
  await click();
  expect(first.focus).toHaveBeenCalled(); expect(second.focus).not.toHaveBeenCalled();
});

test("a client that throws during the display-mode query does not prevent opening the PWA", async () => {
  const { matchAll, click } = worker();
  const broken = pane(), app = pane(true);
  broken.postMessage.mockImplementation(() => { throw new Error("Window closed"); });
  matchAll.mockResolvedValue([broken, app]);
  await click();
  expect(app.focus).toHaveBeenCalled();
});

test.each(["https://other.test/", "/api/attention", "http://["])("invalid notification target %s is ignored", async url => {
  const { click, matchAll, openWindow } = worker();
  await click(url);
  expect(matchAll).not.toHaveBeenCalled(); expect(openWindow).not.toHaveBeenCalled();
});

test("cold-start success is retained if the browser refuses an additional focus", async () => {
  const { click, openWindow } = worker();
  const opened = pane(); opened.focus.mockRejectedValue(new Error("Already opened")); openWindow.mockResolvedValue(opened);
  await expect(click()).resolves.toBeUndefined();
  expect(openWindow).toHaveBeenCalledWith(target);
});
