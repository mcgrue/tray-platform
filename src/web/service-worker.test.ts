import vm from "vm";
import fs from "fs";
import path from "path";

function worker() {
  const handlers: Record<string, (event: any) => void> = {};
  const showNotification = jest.fn(async () => {}), openWindow = jest.fn(async () => {}), matchAll = jest.fn(async (): Promise<any[]> => []), cache = { addAll: jest.fn(async () => {}) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "sw.js"), "utf8"), {
    URL, self: { location: { origin: "https://fixture.ts.net" }, addEventListener: (event: string, handler: any) => handlers[event] = handler,
      registration: { showNotification }, clients: { matchAll, openWindow } },
    caches: { open: async () => cache, keys: async () => [], match: jest.fn() }, fetch: jest.fn(),
  });
  return { handlers, showNotification, openWindow, matchAll, cache };
}
test("worker caches no API data and never intercepts writes", async () => {
  const { handlers, cache } = worker(); let installed: Promise<any> = Promise.resolve();
  handlers.install({ waitUntil: (work: Promise<any>) => installed = work }); await installed;
  expect(cache.addAll).toHaveBeenCalledWith(["/offline.html", "/index.css", "/icon-192.png", "/icon-512.png"]);
  for (const [url, method] of [["https://fixture.ts.net/api/attention", "GET"], ["https://fixture.ts.net/api/attention/a/b/messages", "POST"], ["https://other.test/index.css", "GET"]]) {
    const respondWith = jest.fn(); handlers.fetch({ request: { url, method }, respondWith }); expect(respondWith).not.toHaveBeenCalled();
  }
});
test("notification clicks focus an existing pane without navigating away from its drafts", async () => {
  const { handlers, matchAll, openWindow } = worker();
  const client = { url: "https://fixture.ts.net/", postMessage: jest.fn(), focus: jest.fn(async () => {}), navigate: jest.fn() };
  matchAll.mockResolvedValue([client]); let work = Promise.resolve();
  handlers.notificationclick({ notification: { close: jest.fn(), data: { url: "/#item=fixture" } }, waitUntil: (value: Promise<any>) => work = value }); await work;
  expect(client.postMessage).toHaveBeenCalledWith({ type: "attention-open", url: "https://fixture.ts.net/#item=fixture" });
  expect(client.focus).toHaveBeenCalled(); expect(client.navigate).not.toHaveBeenCalled(); expect(openWindow).not.toHaveBeenCalled();
});
test("push is displayed without contacting the private server and click URLs stay on origin", async () => {
  const { handlers, showNotification, openWindow } = worker(); let work: Promise<any> = Promise.resolve();
  handlers.push({ data: { json: () => ({ title: "Done", body: "Project", url: "https://evil.test" }) }, waitUntil: (value: Promise<any>) => work = value }); await work;
  expect(showNotification).toHaveBeenCalledWith("Done", expect.objectContaining({ data: { url: "/" } }));
  const close = jest.fn(); handlers.notificationclick({ notification: { close, data: { url: "https://evil.test" } }, waitUntil: (value: Promise<any>) => work = value }); await work;
  expect(close).toHaveBeenCalled(); expect(openWindow).not.toHaveBeenCalled();
  handlers.notificationclick({ notification: { close, data: { url: "/#item=fixture" } }, waitUntil: (value: Promise<any>) => work = value }); await work;
  expect(openWindow).toHaveBeenCalledWith("https://fixture.ts.net/#item=fixture");
});
