// Isolated rich editing host; synthetic clipboard images never touch the OS clipboard.
const assert = require("assert").strict, fs = require("fs"), os = require("os"), path = require("path");
const { app, BrowserWindow } = require("electron");
const root = path.join(__dirname, ".."), directory = fs.mkdtempSync(path.join(os.tmpdir(), "tray-message-input-"));
app.setPath("userData", path.join(directory, "profile"));
const bundle = require("esbuild").buildSync({ stdin: { contents: `
  import { createCodexMessageInput } from './src/app/codex-message-input';
  import { mountCodexAttachmentsUI, newAttachmentDraft } from './src/app/codex-attachments-ui';
  const form = document.querySelector('form'), label = document.querySelector('label');
  const input = createCodexMessageInput({ phone: true, label: 'Message', placeholder: 'Tell Codex what to do next…', rows: 3, maxLength: 40 });
  label.append(input.element);
  const draft = newAttachmentDraft();
  const attachments = mountCodexAttachmentsUI(document.querySelector('section'), form, { uploadCodexAttachment: async () => { throw Error('No uploads in this fixture'); } }, () => draft, () => attachments.refresh());
  form.append(attachments.button);
  window.fixture = { input, draft, attachments };
`, resolveDir: root }, write: false, bundle: true, platform: "browser" }).outputFiles[0].text;
fs.writeFileSync(path.join(directory, "fixture.html"), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Keyboard image input smoke</title><fieldset><form><label>Message</label><section></section></form></fieldset>');
const png = fs.readFileSync(path.join(root, "src/web/icon-192.png")).toString("base64");
let window;
const evaluate = (fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
const value = () => evaluate(() => fixture.input.value);
const paste = (text, html) => evaluate((text, html) => {
  const transfer = new DataTransfer(); transfer.setData('text/plain', text); if (html) transfer.setData('text/html', html);
  fixture.input.element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
}, text, html);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(label, predicate) { for (let i = 0; i < 100; i++) { if (await predicate()) return; await pause(30); } throw Error('Timeout: ' + label); }
async function run() {
  await app.whenReady();
  window = new BrowserWindow({ width: 390, height: 844, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await window.loadFile(path.join(directory, 'fixture.html'));
  await window.webContents.insertCSS(fs.readFileSync(path.join(root, 'dist/web/index.css'), 'utf8'));
  await window.webContents.executeJavaScript(bundle);
  assert(await evaluate(() => {
    const node = fixture.input.element;
    return node.contentEditable === 'true' && node.getAttribute('role') === 'textbox' && node.getAttribute('aria-label') === 'Message' && node.getAttribute('aria-multiline') === 'true';
  }), 'Image-capable editing host has an accessible multiline textbox role');
  await evaluate(() => { fixture.input.focus(); document.execCommand('insertText', false, 'one'); document.execCommand('insertParagraph'); document.execCommand('insertText', false, 'two'); });
  assert.equal(await value(), 'one\ntwo', 'Typed line breaks serialize as plain text');
  await evaluate(() => { fixture.input.value = 'keep '; fixture.input.focus(); const range = document.createRange(); range.selectNodeContents(fixture.input.element); range.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(range); });
  await paste('plain\ntext', '<b>plain</b><img src="bad" onerror="window.executed=true">');
  assert.equal(await value(), 'keep plain\ntext');
  assert(await evaluate(() => !window.executed && !fixture.input.element.querySelector('b, img, script')), 'HTML clipboard content stays inert');
  await evaluate(() => document.execCommand('undo'));
  assert.equal(await value(), 'keep ', 'Paste participates in native undo');
  await evaluate(() => document.execCommand('redo'));
  assert.equal(await value(), 'keep plain\ntext');
  await evaluate(png => {
    const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(atob(png), c => c.charCodeAt(0))], 'clipboard.png', { type: 'image/png' }));
    fixture.input.element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, png);
  await wait('pasted image thumbnail', () => evaluate(() => document.querySelector('[data-attachment-thumbnail] img')?.naturalWidth > 0));
  assert.equal(await value(), 'keep plain\ntext');
  assert.equal(await evaluate(() => fixture.draft.files.length), 1, 'Keyboard image uses attachment flow');
  assert.equal(await evaluate(() => fixture.input.element.querySelectorAll('img').length), 0, 'Images appear in attachment strip, not message text');
  await evaluate(() => { document.querySelector('fieldset').disabled = true; });
  assert.equal(await evaluate(() => fixture.input.element.contentEditable), 'false', 'Inherited offline fieldset disables editing');
  await paste('blocked'); assert.equal(await value(), 'keep plain\ntext');
  await evaluate(() => { document.querySelector('fieldset').disabled = false; });
  assert.equal(await evaluate(() => fixture.input.element.contentEditable), 'true');
  await evaluate(() => { fixture.input.disabled = true; });
  assert.equal(await evaluate(() => fixture.input.element.getAttribute('aria-disabled')), 'true');
  await evaluate(() => { fixture.input.disabled = false; fixture.input.value = ''; fixture.input.focus(); });
  await paste('x'.repeat(50)); assert.equal((await value()).length, 40, 'Pasted text obeys message length limit');
  await evaluate(() => { fixture.input.value = ''; fixture.input.element.dispatchEvent(new CompositionEvent('compositionstart')); fixture.input.element.textContent = 'あ'.repeat(41); fixture.input.element.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true })); });
  assert.equal((await value()).length, 41, 'Composition is not interrupted');
  await evaluate(() => fixture.input.element.dispatchEvent(new CompositionEvent('compositionend')));
  assert.equal((await value()).length, 40, 'Length limit applies after composition completes');
  await evaluate(() => { fixture.input.value = 'draft\nsecond line'; document.querySelector('form').hidden = true; });
  assert.equal(await value(), 'draft\nsecond line', 'Hidden drafts retain their line breaks');
  await evaluate(() => { document.querySelector('form').hidden = false; fixture.input.focus(); });
  assert(await evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  window.showInactive(); await pause(100);
  fs.writeFileSync(path.join(directory, 'phone-editor.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate(() => { fixture.input.dispose(); fixture.attachments.dispose(); });
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: true, checks: ['accessible rich editing host', 'newlines', 'plain text paste', 'undo/redo', 'image attachments', 'offline and sending locks', 'length limit', 'IME composition', 'hidden draft retention', 'narrow layout'], directory }, null, 2));
  console.log('PASS mobile message input:', directory);
}
app.on('window-all-closed', () => {});
const watchdog = setTimeout(() => { console.error('Message input smoke timed out:', directory); app.exit(1); }, 30000);
run().then(() => { clearTimeout(watchdog); app.exit(0); }, error => { console.error(error, directory); clearTimeout(watchdog); app.exit(1); });
