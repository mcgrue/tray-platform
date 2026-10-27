// Real browser editing and keyboard events with an isolated message bridge.
const assert = require("assert").strict, fs = require("fs"), os = require("os"), path = require("path");
const { app, BrowserWindow } = require("electron");
const root = path.join(__dirname, ".."), directory = fs.mkdtempSync(path.join(os.tmpdir(), "tray-new-instruction-"));
app.setPath("userData", path.join(directory, "profile"));
const bundle = require("esbuild").buildSync({ stdin: { contents: `
  import { mountAttentionUI } from './src/app/attention-ui';
  import { readCodexMessageText } from './src/app/codex-message-input';
  const origin = { kind: 'vscode-codex', codexPid: 1, codexStartedAt: 'fixture', vscodePid: 2, vscodeStartedAt: 'fixture' };
  const item = { source: 'codex', id: 'completion-' + 'a'.repeat(64), title: 'Done: keyboard fixture', codexSessionId: 'fixture', origin, state: 'pending', createdAt: 1, updatedAt: 1 };
  let dispose;
  const fixture = window.fixture = { sent: [], hold: false, fail: false, release: undefined,
    read: () => readCodexMessageText(document.querySelector('[data-message-input]')), mount(phone) {
    dispose?.(); fixture.sent = []; fixture.hold = fixture.fail = false;
    const bridge = { getAttention: async () => ({ items: [item] }), onAttentionChanged: () => () => {},
      sendAttentionMessage: async (_source, _id, message) => {
        fixture.sent.push(message);
        if (fixture.hold) await new Promise(resolve => fixture.release = resolve);
        if (fixture.fail) throw new Error('Fixture delivery failed');
        return { sessionId: 'fixture', turnId: 'fixture', delivery: 'started' };
      } };
    dispose = mountAttentionUI(document.querySelector('#inbox'), bridge, phone ? { navigation: 'phone' } : {});
  } };
`, resolveDir: root }, write: false, bundle: true, platform: "browser" }).outputFiles[0].text;
fs.writeFileSync(path.join(directory, "fixture.html"), '<!doctype html><meta charset="utf-8"><title>New instruction smoke</title><fieldset><main id="inbox"></main></fieldset>');
let window;
const evaluate = (fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
async function wait(label, predicate) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error("Timeout: " + label);
}
const setDraft = (text, start = text.length, end = start) => evaluate((text, start, end) => {
  const input = document.querySelector('[data-message-input]'); input.focus();
  if (input.tagName === 'TEXTAREA') { input.value = text; input.setSelectionRange(start, end); }
  else {
    input.textContent = text;
    const range = document.createRange();
    if (input.firstChild) { range.setStart(input.firstChild, start); range.setEnd(input.firstChild, end); }
    else { range.selectNodeContents(input); range.collapse(false); }
    getSelection().removeAllRanges(); getSelection().addRange(range);
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
}, text, start, end);
const draft = () => evaluate(() => fixture.read());
const sent = () => evaluate(() => fixture.sent);
const enter = async (modifiers = []) => {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return', modifiers });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return', modifiers });
  await evaluate(() => undefined);
};
async function run() {
  await app.whenReady();
  window = new BrowserWindow({ show: false, width: 480, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await window.loadFile(path.join(directory, 'fixture.html'));
  await window.webContents.insertCSS(fs.readFileSync(path.join(root, 'dist/web/index.css'), 'utf8'));
  await window.webContents.executeJavaScript(bundle);
  for (const phone of [false, true]) {
    await evaluate(phone => fixture.mount(phone), phone);
    await wait('composer', () => evaluate(() => !!document.querySelector('[data-send-instruction]')));
    if (phone) await evaluate(() => document.querySelector('[data-attention-disclosure]').click());
    assert.equal(await evaluate(() => document.body.textContent.includes('Ctrl+Enter to send to this conversation.')), false);
    assert.equal(await evaluate(() => document.body.textContent.includes('Go focuses the originating VS Code window.')), false);
    assert.equal(await evaluate(() => [...document.querySelectorAll('button')].filter(button => button.textContent === 'Go').length), phone ? 0 : 1);
    assert.equal(await evaluate(() => document.querySelector('[data-message-input]').getAttribute('enterkeyhint')), 'send');
    await setDraft('firstsecond', 5);
    await enter(['control']);
    assert.equal(await draft(), 'first\nsecond', 'Ctrl+Enter inserts at the caret');
    assert.deepEqual(await sent(), []);
    await evaluate(() => document.execCommand('undo'));
    assert.equal(await draft(), 'firstsecond', 'Inserted newline participates in native undo');
    await setDraft('firstREMOVEsecond', 5, 11); await enter(['control']);
    assert.equal(await draft(), 'first\nsecond', 'Ctrl+Enter replaces selected text');
    await enter();
    await wait('Enter sent', async () => (await sent()).length === 1 && await draft() === '');
    assert.deepEqual(await sent(), ['first\nsecond']);
    await setDraft('next'); await enter(['shift']);
    assert.equal(await draft(), 'next\n', 'Shift+Enter also retains multiline editing');
    assert.equal((await sent()).length, 1);
    await setDraft('IME candidate');
    await evaluate(() => {
      const input = document.querySelector('[data-message-input]');
      input.dispatchEvent(new CompositionEvent('compositionstart'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      input.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true, cancelable: true, isComposing: true }));
      input.dispatchEvent(new CompositionEvent('compositionend'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }));
    });
    assert.equal((await sent()).length, 1, 'IME confirmation never sends');
    await setDraft('Soft keyboard send'); await enter(['control']);
    await evaluate(() => document.querySelector('[data-message-input]').dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true, cancelable: true })));
    await wait('editing action sent', async () => (await sent()).length === 2 && await draft() === '');
    assert.equal((await sent())[1], 'Soft keyboard send\n', 'The delivered message contains exactly one trailing newline');
    await setDraft('Offline draft');
    await evaluate(() => { document.querySelector('fieldset').disabled = true; });
    await evaluate(() => document.querySelector('[data-message-input]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    assert.equal((await sent()).length, 2, 'Offline controls block Enter send');
    await evaluate(() => { document.querySelector('fieldset').disabled = false; fixture.hold = true; });
    await setDraft('Once only'); await enter();
    await wait('pending send', async () => (await sent()).length === 3);
    await evaluate(() => document.querySelector('[data-message-input]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    assert.equal((await sent()).length, 3, 'Pending sends cannot be duplicated');
    await evaluate(() => { fixture.hold = false; fixture.release(); });
    await wait('released', async () => await draft() === '');
    await evaluate(() => { fixture.fail = true; });
    await setDraft('Keep failed draft'); await enter();
    await wait('failed', () => evaluate(() => document.body.textContent.includes('Fixture delivery failed')));
    assert.equal(await draft(), 'Keep failed draft');
    await setDraft(''); await enter(['control']);
    assert.equal(await draft(), '\n', 'Ctrl+Enter can start a blank line');
    await enter(); assert.equal((await sent()).length, 4, 'Whitespace-only instructions do not send');
    await setDraft('x'.repeat(20000)); await enter(['control']);
    assert.equal((await draft()).length, 20000, 'Newline obeys the message length limit');
    await setDraft(''); await enter(['control']);
    await evaluate(() => { fixture.fail = false; document.execCommand('insertText', false, 'after'); });
    await enter();
    await wait('leading newline sent', async () => (await sent()).length === 5 && await draft() === '');
    assert.equal((await sent())[4], '\nafter', 'The delivered message preserves a leading blank line');
    await setDraft('New instruction\nSecond line');
    fs.writeFileSync(path.join(directory, phone ? 'phone.png' : 'desktop.png'), (await window.webContents.capturePage()).toPNG());
  }
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: true, directory, checks: ['desktop and phone Enter send', 'Ctrl+Enter selection and undo', 'IME and soft keyboard', 'offline and pending locks', 'failed draft retention', 'length limit', 'reminders removed', 'PWA has no Go button'] }, null, 2));
  console.log('PASS New Instruction browser smoke:', directory);
}
const watchdog = setTimeout(() => { console.error('New Instruction smoke timed out'); app.exit(1); }, 45000);
run().then(() => { clearTimeout(watchdog); app.exit(0); }, error => { console.error(error, directory); clearTimeout(watchdog); app.exit(1); });
