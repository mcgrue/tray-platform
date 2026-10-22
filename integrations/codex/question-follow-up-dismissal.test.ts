import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
const { prepareFollowUps, inspect, install, REPLACEMENT, FOLLOW_UP_ORIGINAL, FOLLOW_UP_REPLACEMENT } = require("./question-dismissal.cjs");

const source = REPLACEMENT + ";" + FOLLOW_UP_ORIGINAL;
test("follow-up preparation preserves the base dismissal patch and is idempotent", () => {
  const patched = prepareFollowUps(source);
  expect(patched).toBe(REPLACEMENT + ";" + FOLLOW_UP_REPLACEMENT);
  expect(prepareFollowUps(patched)).toBe(patched);
});

test.each(["unknown watcher", FOLLOW_UP_ORIGINAL, REPLACEMENT, source + FOLLOW_UP_ORIGINAL])(
  "rejects an unsupported or ambiguous watcher: %s", input => expect(() => prepareFollowUps(input)).toThrow("no patch applied"));

test("follow-up installation is opt-in and preserves the exact previous asset as a backup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tray-question-follow-up-"));
  const directory = path.join(root, "webview", "assets");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ publisher: "openai", name: "chatgpt", version: "26.1007.21434" }));
  const file = path.join(directory, "app-initial-fixture.js");
  await fs.writeFile(file, source);
  expect(inspect(root).changed).toBe(false);
  expect(inspect(root, { followUps: true }).changed).toBe(true);
  expect(await fs.readFile(file, "utf8")).toBe(source);
  const installed = install(root, { followUps: true });
  expect(await fs.readFile(installed.backup, "utf8")).toBe(source);
  expect(await fs.readFile(file, "utf8")).toBe(prepareFollowUps(source));
  expect(install(root, { followUps: true })).toEqual({ file, alreadyApplied: true });
});
