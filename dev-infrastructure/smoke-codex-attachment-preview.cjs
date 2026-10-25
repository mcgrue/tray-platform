// Isolated attachment UI with production styles; no live messages or file uploads.
const assert = require("assert").strict, fs = require("fs"), os = require("os"), path = require("path");
const { app, BrowserWindow } = require("electron");
const root = path.join(__dirname, ".."), directory = fs.mkdtempSync(path.join(os.tmpdir(), "tray-attachment-preview-"));
app.setPath("userData", path.join(directory, "profile"));
const bundle = require("esbuild").buildSync({ stdin: { contents: `
  import { mountCodexAttachmentsUI, newAttachmentDraft } from './src/app/codex-attachments-ui';
  const drafts = [newAttachmentDraft(), newAttachmentDraft()]; let active = 0, disabled = false;
  const form = document.querySelector('form'), root = document.querySelector('#attachments');
  const ui = mountCodexAttachmentsUI(root, form, { uploadCodexAttachment: async () => { throw Error('Fixture upload failed'); } }, () => drafts[active], () => ui.refresh(disabled));
  document.querySelector('[data-composer-actions]').prepend(ui.button);
  Object.assign(window, { fixture: { refresh: () => ui.refresh(disabled), select: index => { active = index; ui.refresh(disabled); },
    disable: value => { disabled = value; ui.refresh(disabled); }, dispose: () => ui.dispose(),
    failUpload: async () => { try { await ui.upload(drafts[active]); } catch {} }, count: () => drafts[active].files.length } });
`, resolveDir: root }, write: false, bundle: true, platform: "browser" }).outputFiles[0].text;
fs.writeFileSync(path.join(directory, "fixture.html"), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Attachment preview smoke</title></head><body><h2>Message Codex</h2><fieldset><form><label>Message<textarea placeholder="Tell Codex what to do next…"></textarea></label><section id="attachments"></section><div data-composer-actions><button type="button">Send message</button></div></form></fieldset></body></html>`);
const image = fs.readFileSync(path.join(root, "src/web/icon-192.png")).toString("base64"), errors = [];
const evaluate = (window, fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(label, predicate) { for (let i = 0; i < 100; i++) { if (await predicate()) return; await pause(30); } throw Error("Timeout: " + label); }
const add = (window, files) => evaluate(window, files => {
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(new File([file.base64 ? Uint8Array.from(atob(file.base64), c => c.charCodeAt(0)) : file.text], file.name, { type: file.type }));
  document.querySelector("form").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
}, files);
const click = (window, selector) => evaluate(window, selector => document.querySelector(selector).click(), selector);
const count = window => evaluate(window, () => fixture.count());
const isOpen = window => evaluate(window, () => !!document.querySelector("[data-attachment-preview][open]"));
async function screenshot(window, name) {
  window.showInactive(); await pause(100);
  fs.writeFileSync(path.join(directory, name + ".png"), (await window.webContents.capturePage()).toPNG()); window.hide();
}
let window;
async function run() {
  await app.whenReady();
  for (const [name, width, height] of [["desktop", 1000, 800], ["phone", 390, 844]]) {
    window = new BrowserWindow({ width, height, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    window.webContents.on("console-message", (_event, level, message) => { if (level === 3) errors.push(message); });
    await window.loadFile(path.join(directory, "fixture.html"));
    await window.webContents.insertCSS(fs.readFileSync(path.join(root, "dist/app/index.css"), "utf8"));
    await window.webContents.executeJavaScript(bundle);
    await add(window, [{ name: "picture.png", type: "image/png", base64: image }, { name: "example.html", type: "text/html", text: '<script>window.executed = true</script>\n<h1>File contents stay inert</h1>' }]);
    assert.equal(await count(window), 2);
    await wait("decoded image thumbnail", () => evaluate(window, () => document.querySelector("[data-attachment-thumbnail] img")?.naturalWidth > 0));
    assert(await evaluate(window, () => {
      const list = document.querySelector("[data-codex-attachments] ul"), buttons = [...list.querySelectorAll("button")];
      const thumbnail = list.querySelector("img"), image = thumbnail.getBoundingClientRect();
      return thumbnail.alt === "" && image.width >= 30 && image.width <= 44 && image.height === image.width && getComputedStyle(thumbnail).objectFit === "cover" &&
        !list.innerText.includes("picture.png") && !list.innerText.includes("example.html") && buttons.length === 2 && buttons.every(button => {
        const bounds = button.getBoundingClientRect(); return bounds.width === 44 && bounds.height === 44 && button.querySelector(button.dataset.attachmentKind === "image" ? "img" : "svg") && button.getAttribute("aria-haspopup") === "dialog";
      }) && document.documentElement.scrollWidth <= innerWidth;
    }), "Compact image thumbnails and accessible file icons fit the attachment strip");
    assert.equal(await evaluate(window, () => document.querySelector("[data-attachment-thumbnail] img").src), "data:image/png;base64," + image, "Thumbnail displays the selected image");
    await screenshot(window, name + "-icons");
    await click(window, '[data-attachment-kind="image"]');
    await wait("decoded image preview", () => evaluate(window, () => document.querySelector("[data-attachment-content] img")?.naturalWidth > 0));
    assert(await evaluate(window, () => {
      const dialog = document.querySelector("dialog"), bounds = dialog.getBoundingClientRect(), metadata = dialog.querySelector("[data-attachment-metadata]"), overlay = metadata.getBoundingClientRect();
      const removeButton = dialog.querySelector("[data-attachment-remove]"), closeButton = dialog.querySelector("[data-attachment-back]"),
        remove = removeButton.getBoundingClientRect(), close = closeButton.getBoundingClientRect();
      return dialog.open && bounds.width > 250 && bounds.height > 250 && bounds.left >= 15 && bounds.right <= innerWidth - 15 && bounds.top >= 0 && bounds.bottom <= innerHeight &&
        metadata.querySelector("strong").textContent === "picture.png" && /KiB| B/.test(metadata.children[1].textContent) && overlay.bottom <= bounds.bottom && overlay.top > bounds.top &&
        remove.left > bounds.left && Math.abs(close.left - remove.right - 8) < 1 && close.right < bounds.right && close.right > bounds.right - 20 &&
        remove.top === close.top && close.top < bounds.top + 20 && remove.width >= 44 && close.width >= 44 &&
        removeButton.getAttribute("aria-label") === "Remove picture.png" && closeButton.getAttribute("aria-label") === "Close preview" &&
        !!removeButton.querySelector("svg") && !!closeButton.querySelector("svg") && getComputedStyle(closeButton).color === "rgb(248, 113, 113)" &&
        dialog.querySelector("img").getBoundingClientRect().width > 200;
    }), "Large preview fits viewport with accessible trash and red close buttons side by side at top right");
    await screenshot(window, name + "-image");
    await evaluate(window, () => { window.originalDialog = document.querySelector("dialog"); fixture.refresh(); });
    assert(await evaluate(window, () => document.querySelector("dialog") === window.originalDialog && document.querySelector("dialog").open), "Snapshot refresh keeps preview mounted");
    await click(window, "[data-attachment-back]"); assert.equal(await count(window), 2); assert.equal(await isOpen(window), false);
    assert(await evaluate(window, () => document.activeElement.matches('[data-attachment-kind="image"]')), "Closing restores focus after refreshed icons");
    await click(window, '[data-attachment-kind="image"]');
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" }); window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await wait("Escape closes preview", async () => !await isOpen(window)); assert.equal(await count(window), 2);
    await click(window, '[data-attachment-kind="file"]');
    await wait("inert source preview", () => evaluate(window, () => document.querySelector("dialog pre")?.textContent.includes("File contents stay inert")));
    assert(await evaluate(window, () => !window.executed && !document.querySelector("dialog script") && !document.querySelector("dialog h1")));
    await screenshot(window, name + "-file");
    await click(window, "[data-attachment-remove]"); assert.equal(await count(window), 1); assert.equal(await isOpen(window), false);
    assert(await evaluate(window, () => !!document.querySelector('[data-attachment-kind="image"]')), "Remove affects only the selected attachment");
    await click(window, '[data-attachment-kind="image"]');
    await evaluate(window, () => { fixture.disable(true); document.querySelector("[data-attachment-remove]").click(); });
    assert.equal(await count(window), 1); await click(window, "[data-attachment-back]");
    await evaluate(window, () => fixture.disable(false));
    await click(window, '[data-attachment-kind="image"]');
    await evaluate(window, () => { document.querySelector("fieldset").disabled = true; document.querySelector("[data-attachment-remove]").click(); });
    assert.equal(await count(window), 1, "Inherited offline fieldset state prevents modal removal");
    assert(await evaluate(window, () => document.querySelector("[data-attachment-remove]").disabled), "Open modal reflects the offline fieldset state");
    await evaluate(window, () => { document.querySelector("fieldset").disabled = false; });
    assert.equal(await evaluate(window, () => document.querySelector("[data-attachment-remove]").disabled), false, "Reconnect re-enables removal without a draft refresh");
    await click(window, "[data-attachment-back]");
    await evaluate(window, () => { document.querySelector("fieldset").disabled = false; });
    await click(window, '[data-attachment-kind="image"]');
    window.webContents.sendInputEvent({ type: "mouseDown", x: 2, y: 2, button: "left", clickCount: 1 });
    window.webContents.sendInputEvent({ type: "mouseUp", x: 2, y: 2, button: "left", clickCount: 1 });
    await wait("backdrop closes preview", async () => !await isOpen(window)); assert.equal(await count(window), 1);
    await click(window, '[data-attachment-kind="image"]');
    await evaluate(window, () => fixture.select(1)); assert.equal(await isOpen(window), false); assert.equal(await count(window), 0);
    await evaluate(window, () => fixture.select(0)); assert.equal(await count(window), 1, "Switching drafts closes preview and preserves attachments");
    await evaluate(window, () => fixture.failUpload());
    assert(await evaluate(window, () => document.querySelector('[data-attachment-badge="error"]')?.textContent === "!"));
    await click(window, '[data-attachment-kind="image"]');
    assert(await evaluate(window, () => document.querySelector("dialog [role=status]").textContent === "Fixture upload failed"));
    await click(window, "[data-attachment-remove]"); assert.equal(await count(window), 0);
    const longName = "very-long-filename-".repeat(8) + ".txt";
    await add(window, [{ name: longName, type: "text/plain", text: "x".repeat(70 * 1024) }]);
    await click(window, "[data-attachment-open]");
    await wait("bounded text preview", () => evaluate(window, () => document.querySelector("dialog pre")?.textContent.endsWith("Preview truncated to 64 KiB.")));
    assert(await evaluate(window, () => {
      const dialog = document.querySelector("dialog"), metadata = dialog.querySelector("[data-attachment-metadata]");
      const text = dialog.querySelector("pre");
      return dialog.scrollWidth === dialog.clientWidth && metadata.scrollWidth === metadata.clientWidth && text.textContent.length < 66000 && text.getBoundingClientRect().bottom <= metadata.getBoundingClientRect().top;
    }), "Long filenames and source files remain bounded on phone");
    await screenshot(window, name + "-long-filename");
    await click(window, "[data-attachment-remove]");
    await add(window, [{ name: "archive.bin", type: "application/octet-stream", text: "binary" }]); await click(window, "[data-attachment-open]");
    assert(await evaluate(window, () => !!document.querySelector("[data-attachment-file] svg") && document.querySelector("dialog").textContent.includes("No preview available")));
    await evaluate(window, () => fixture.dispose()); assert.equal(await isOpen(window), false);
    assert.equal(await evaluate(window, () => document.querySelectorAll("[data-attachment-preview]").length), 0, "Disposal removes the body-mounted modal");
    window.destroy(); window = undefined;
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({ passed: true, checks: ["desktop/phone icon strip", "image and inert source previews", "metadata overlays", "selected removal", "close/Escape/backdrop preserve drafts", "snapshot focus", "draft isolation", "disabled/offline guards", "error badge", "bounded source and long filename", "binary fallback", "disposal"], directory }, null, 2));
  console.log("PASS attachment preview:", directory);
}
const watchdog = setTimeout(() => { console.error("Preview smoke timed out:", directory); app.exit(1); }, 30000);
app.on("window-all-closed", () => {});
run().then(() => { clearTimeout(watchdog); app.exit(0); }, error => { console.error(error, directory); window?.destroy(); clearTimeout(watchdog); app.exit(1); });
