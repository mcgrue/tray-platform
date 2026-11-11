import fs from "fs";
import os from "os";
import path from "path";

const { retainCompletionImages } = require("./attention-images.cjs");
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==", "base64");

test("Stop hook keeps a private copy of a screenshot linked in the final response", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tray-completion-image-test-"));
  const source = path.join(directory, "pc-config.png");
  fs.writeFileSync(source, pixel);
  const message = `![Updated PC Config screen](${source.replace(/\\/g, "/")})`;
  const item = { source: "codex", id: "completion-abc", body: { description: message } };
  const retained = retainCompletionImages(item, path.join(directory, "retained"));
  expect(item.body.description).toBe(message);
  expect(retained.body.description).toContain("![Updated PC Config screen](<");
  expect(retained.body.description).not.toContain(source.replace(/\\/g, "/"));
  const target = /^!\[[^\]]+\]\(<(.+)>\)$/.exec(retained.body.description)![1];
  expect(fs.readFileSync(target)).toEqual(pixel);
  expect(retainCompletionImages(item, path.join(directory, "retained")).body.description).toBe(retained.body.description);
});

test("missing, remote, and unsupported images leave the completion text intact", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tray-completion-image-reject-"));
  const fake = path.join(directory, "fake.png"); fs.writeFileSync(fake, "not an image");
  const description = [`![Missing](${path.join(directory, "missing.png")})`, "![Remote](https://example.com/image.png)",
    `![Fake](${fake.replace(/\\/g, "/")})`].join("\n");
  const item = { source: "codex", id: "completion-rejected", body: { description } };
  expect(retainCompletionImages(item, path.join(directory, "retained"))).toBe(item);
});
