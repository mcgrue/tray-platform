import { promises as fs, readFileSync } from "fs";
import path = require("path");
import os = require("os");
import { ShortcutService } from "./shortcut-service";
import { ShortcutKey } from "../shared/attention";

const services: ShortcutService[] = [];
async function fixture(options: { raw?: string; capture?: boolean; occupied?: string[] } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tray-shortcuts-test-"));
  const file = path.join(directory, "shortcuts.json");
  if (options.raw !== undefined) await fs.writeFile(file, options.raw);
  const callbacks = new Map<string, () => void>();
  const occupied = new Set(options.occupied || []);
  const register = jest.fn((accelerator: string, callback: () => void) => {
    if (occupied.has(accelerator) || callbacks.has(accelerator)) return false;
    callbacks.set(accelerator, callback); return true;
  });
  const unregister = jest.fn((accelerator: string) => { callbacks.delete(accelerator); });
  const invoke = jest.fn();
  const definitions = [{ key: "navigate" as ShortcutKey, defaultAccelerator: "Ctrl+Alt+Space", onInvoke: invoke }];
  if (options.capture) definitions.push({ key: "capture", defaultAccelerator: "Ctrl+Alt+B", onInvoke: invoke });
  const service = new ShortcutService(file, { register, unregister }, definitions); services.push(service);
  await service.initialize();
  return { service, file, callbacks, register, unregister, invoke, occupied };
}
afterEach(() => { services.splice(0).forEach(service => service.close()); jest.restoreAllMocks(); });

test("registers defaults, invokes callback, detaches snapshots, and cleans up once", async () => {
  const { service, callbacks, invoke, unregister } = await fixture();
  expect(service.list().settings[0]).toEqual({ key: "navigate", accelerator: "Ctrl+Alt+Space", registered: true });
  const callback = callbacks.get("Ctrl+Alt+Space")!; callback(); expect(invoke).toHaveBeenCalledTimes(1);
  service.list().settings[0].accelerator = "Untrusted mutation";
  expect(service.list().settings[0].accelerator).toBe("Ctrl+Alt+Space");
  service.close(); service.close(); callback();
  expect(unregister.mock.calls).toEqual([["Ctrl+Alt+Space"]]); expect(invoke).toHaveBeenCalledTimes(1);
});

test("saves before registration changes and notifications, restores settings and preserves future keys", async () => {
  const raw = JSON.stringify({ version: 1, accelerators: { navigate: "Ctrl+Alt+N", capture: "Ctrl+Alt+C", futureAction: "Ctrl+Alt+F" } });
  const { service, file, register, unregister } = await fixture({ raw });
  register.mockImplementation((accelerator: string) => {
    expect(JSON.parse(readFileSync(file, "utf8")).accelerators.navigate).toBe(accelerator); return true;
  });
  const change = jest.fn(() => expect(JSON.parse(readFileSync(file, "utf8")).accelerators.navigate).toBe("Ctrl+Alt+M"));
  const unsubscribe = service.onChanged(change);
  await service.set("navigate", "Ctrl+Alt+M"); unsubscribe();
  expect(unregister.mock.calls).toEqual([["Ctrl+Alt+N"]]);
  expect(JSON.parse(await fs.readFile(file, "utf8")).accelerators).toEqual({ navigate: "Ctrl+Alt+M", capture: "Ctrl+Alt+C", futureAction: "Ctrl+Alt+F" });
  expect(change).toHaveBeenCalledTimes(1);
});

test("failed save leaves active bindings intact, and later queued writes recover", async () => {
  const { service, file, register, unregister } = await fixture();
  const changed = jest.fn(); service.onChanged(changed);
  jest.spyOn(fs, "rename").mockRejectedValueOnce(new Error("disk full"));
  await expect(service.set("navigate", "Ctrl+Alt+N")).rejects.toThrow("disk full");
  expect(service.list().settings[0].accelerator).toBe("Ctrl+Alt+Space");
  expect(register).toHaveBeenCalledTimes(1); expect(unregister).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
  await Promise.all([service.set("navigate", "Ctrl+Alt+N"), service.set("navigate", "Ctrl+Alt+M")]);
  expect(service.list().settings[0]).toMatchObject({ accelerator: "Ctrl+Alt+M", registered: true });
  expect(JSON.parse(await fs.readFile(file, "utf8")).accelerators.navigate).toBe("Ctrl+Alt+M");
  expect(changed).toHaveBeenCalledTimes(2);
});

test("retains requested conflicting binding and never unregisters another action's binding", async () => {
  const { service, file, unregister, callbacks } = await fixture({ capture: true });
  await service.set("capture", "Ctrl+Alt+Space");
  expect(unregister.mock.calls).toEqual([["Ctrl+Alt+B"]]);
  expect(callbacks.has("Ctrl+Alt+Space")).toBe(true);
  expect(service.list().settings.find(setting => setting.key === "capture")).toMatchObject({ accelerator: "Ctrl+Alt+Space", registered: false, error: expect.stringContaining("another action") });
  expect(JSON.parse(await fs.readFile(file, "utf8")).accelerators.capture).toBe("Ctrl+Alt+Space");
  await service.set("navigate", "Ctrl+Alt+N");
  expect(service.list().settings.every(setting => setting.registered)).toBe(true);
  expect(callbacks.has("Ctrl+Alt+Space")).toBe(true);
});

test("reports OS registration conflicts and invalid-accelerator exceptions without failing initialization", async () => {
  const { service, occupied, register } = await fixture({ occupied: ["Ctrl+Alt+Space"] });
  expect(service.list().settings[0]).toMatchObject({ registered: false, error: expect.stringContaining("conflicts") });
  occupied.clear(); register.mockImplementationOnce(() => { throw new Error("invalid syntax"); });
  await service.set("navigate", "InvalidAccelerator");
  expect(service.list().settings[0]).toMatchObject({ accelerator: "InvalidAccelerator", registered: false, error: expect.stringContaining("invalid syntax") });
  await service.set("navigate", "Ctrl+Alt+N");
  expect(service.list().settings[0].registered).toBe(true);
});

test("recognizes reordered modifier aliases as an existing binding", async () => {
  const { service, register, unregister } = await fixture({ capture: true });
  await service.set("capture", "alt+Control+space");
  expect(service.list().settings.find(setting => setting.key === "capture")).toMatchObject({ registered: false, error: expect.stringContaining("another action") });
  expect(register).toHaveBeenCalledTimes(2);
  expect(unregister.mock.calls).toEqual([["Ctrl+Alt+B"]]);
});

test("initialization publishes persisted registration and avoids an alias already registered in the process", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tray-shortcuts-init-"));
  const file = path.join(directory, "shortcuts.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, accelerators: { navigate: "CommandOrControl+Shift+N" } }));
  const register = jest.fn(() => true);
  const service = new ShortcutService(file, {
    register,
    unregister: jest.fn(),
    isRegistered: (accelerator: string) => accelerator === "CommandOrControl+Shift+N",
  }, [{ key: "navigate", defaultAccelerator: "Ctrl+Alt+Space", onInvoke: jest.fn() }]);
  services.push(service);
  const changed = jest.fn(); service.onChanged(changed);
  await service.initialize();
  expect(changed).toHaveBeenCalledTimes(1);
  expect(changed.mock.calls[0][0].settings[0]).toMatchObject({ accelerator: "CommandOrControl+Shift+N", registered: false, error: expect.stringContaining("already registered") });
  expect(register).not.toHaveBeenCalled();
});

test.each(["{broken", '{"version":2,"accelerators":{}}', '{"version":1,"accelerators":{"navigate":17}}'])("preserves malformed/unsupported store and registers defaults: %s", async raw => {
  const { service, file } = await fixture({ raw });
  expect(service.list().error).toContain("read-only");
  expect(service.list().settings[0]).toMatchObject({ accelerator: "Ctrl+Alt+Space", registered: true });
  await expect(service.set("navigate", "Ctrl+Alt+N")).rejects.toThrow("read-only");
  expect(await fs.readFile(file, "utf8")).toBe(raw);
});

test("validates keys and empty bindings without touching active shortcuts", async () => {
  const { service, unregister } = await fixture();
  await expect(service.set("capture", "Ctrl+Alt+B")).rejects.toThrow("Unknown shortcut");
  await expect(service.set("navigate", "")).rejects.toThrow("nonempty");
  expect(unregister).not.toHaveBeenCalled();
});
