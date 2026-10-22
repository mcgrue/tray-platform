import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
const { prepare, inspect, install, ORIGINAL, REPLACEMENT } = require("./question-dismissal.cjs");

test("preparation changes exactly the verified question state block and is idempotent", () => {
  const source = "before;" + ORIGINAL + ";after";
  expect(prepare(source)).toBe("before;" + REPLACEMENT + ";after");
  expect(prepare(prepare(source))).toBe(prepare(source));
});

test.each(["changed implementation", ORIGINAL + ORIGINAL, "/* tray-platform: dismiss externally answered questions v1 */"])(
  "unexpected source fails closed: %s", source => expect(() => prepare(source)).toThrow("no patch applied"));

async function fixture(version = "26.1007.21434") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tray-question-dismissal-"));
  await fs.mkdir(path.join(root, "webview", "assets"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ publisher: "openai", name: "chatgpt", version }));
  const file = path.join(root, "webview", "assets", "app-initial-fixture.js");
  await fs.writeFile(file, "before;" + ORIGINAL + ";after");
  return { root, file };
}

test("dry run leaves installed bytes unchanged; explicit installation retains a verified backup", async () => {
  const { root, file } = await fixture(), original = await fs.readFile(file, "utf8");
  expect(inspect(root).changed).toBe(true);
  expect(await fs.readFile(file, "utf8")).toBe(original);
  const result = install(root);
  expect(await fs.readFile(result.backup, "utf8")).toBe(original);
  expect(await fs.readFile(file, "utf8")).toBe(prepare(original));
  expect(install(root)).toEqual({ file, alreadyApplied: true });
  expect(await fs.readFile(result.backup, "utf8")).toBe(original);
});

test("unknown extension versions are not modified", async () => {
  const { root, file } = await fixture("future"), original = await fs.readFile(file, "utf8");
  expect(() => install(root)).toThrow("verified only");
  expect(await fs.readFile(file, "utf8")).toBe(original);
});

test("ambiguous assets are not modified", async () => {
  const { root, file } = await fixture(), original = await fs.readFile(file, "utf8");
  await fs.writeFile(path.join(path.dirname(file), "app-initial-duplicate.js"), original);
  expect(() => install(root)).toThrow("uniquely identify");
  expect(await fs.readFile(file, "utf8")).toBe(original);
});
