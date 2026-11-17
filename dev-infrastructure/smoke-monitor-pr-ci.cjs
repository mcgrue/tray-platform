// Real browser clicks against an isolated Codex message bridge.
const assert = require("assert").strict;
const fs = require("fs"), os = require("os"), path = require("path");
const { app, BrowserWindow } = require("electron");
const root = path.join(__dirname, "..");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tray-monitor-pr-ci-"));
app.setPath("userData", path.join(directory, "profile"));
const message = "Monitor the PR's CI run on a 4 minute poll - if red, fix it; if green merge it";
const bundle = require("esbuild").buildSync({ stdin: { contents: `
  import { mountCodexMessageUI } from './src/app/codex-message-ui';
  let mounted, recovered;
  const fixture = window.fixture = { sent: [], hold: false, fail: false, release: undefined,
    mount(phone, completion) {
      mounted?.dispose(); document.querySelector('#root').replaceChildren();
      fixture.sent = []; fixture.hold = fixture.fail = false;
      const item = { source: 'codex', id: completion ? 'completion-' + 'a'.repeat(64) : 'ordinary',
        title: 'Codex', codexSessionId: 'fixture', state: 'pending', createdAt: 1, updatedAt: 1 };
      const bridge = { sendAttentionMessage: async (_source, _id, message) => {
        fixture.sent.push(message);
        if (fixture.hold) await new Promise(resolve => fixture.release = resolve);
        if (fixture.fail) throw new Error('Fixture delivery failed');
        return { sessionId: 'fixture', turnId: 'fixture', delivery: 'started' };
      }, onRecoveredDelivery: callback => { recovered = callback; return () => { recovered = undefined; }; } };
      mounted = mountCodexMessageUI(document.querySelector('#root'), bridge, item, { phone });
    }, recover() { recovered?.({ source: 'codex', id: 'completion-' + 'a'.repeat(64), action: 'messages' }); }
  };
`, resolveDir: root }, write: false, bundle: true, platform: "browser" }).outputFiles[0].text;

let window;
const evaluate = (fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
async function wait(label, predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error("Timeout: " + label);
}
const draft = () => evaluate(() => document.querySelector('[data-message-input]').tagName === 'TEXTAREA'
  ? document.querySelector('[data-message-input]').value : document.querySelector('[data-message-input]').textContent);
const setDraft = text => evaluate(text => {
  const input = document.querySelector('[data-message-input]');
  if (input.tagName === 'TEXTAREA') input.value = text;
  else input.textContent = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}, text);
const click = () => evaluate(() => document.querySelector('[data-monitor-pr-ci]').click());

async function run() {
  await app.whenReady();
  window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html,<meta charset="utf-8"><main id="root"></main>');
  await window.webContents.executeJavaScript(bundle);
  for (const phone of [false, true]) {
    await evaluate(phone => fixture.mount(phone, true), phone);
    assert.equal(await evaluate(() => document.querySelector('[data-monitor-pr-ci]').title), message);
    assert.equal(await evaluate(() => document.querySelector('[data-monitor-pr-ci]').disabled), false);
    await setDraft('Keep my draft');
    await click();
    await wait('preset acknowledged', () => evaluate(() => document.querySelector('[role="status"]').textContent === 'Sent to Codex as a follow-up.'));
    assert.deepEqual(await evaluate(() => fixture.sent), [message]);
    assert.equal(await draft(), 'Keep my draft');

    await evaluate(() => { fixture.hold = true; });
    await click();
    await wait('preset in flight', () => evaluate(() => fixture.sent.length === 2));
    assert.equal(await evaluate(() => document.querySelector('[data-monitor-pr-ci]').disabled), true);
    await click();
    assert.equal((await evaluate(() => fixture.sent)).length, 2, 'Pending preset cannot send twice');
    await evaluate(() => { fixture.hold = false; fixture.release(); });
    await wait('preset released', () => evaluate(() => !document.querySelector('[data-monitor-pr-ci]').disabled));

    await setDraft(message);
    await click();
    await wait('matching draft preset sent', () => evaluate(() => fixture.sent.length === 3));
    await evaluate(() => fixture.recover());
    assert.equal(await draft(), message, 'Recovered preset does not clear a matching manual draft');

    await evaluate(() => { fixture.fail = true; });
    await click();
    await wait('preset error', () => evaluate(() => document.querySelector('[role="alert"]').textContent.includes('Fixture delivery failed')));
    assert.equal(await draft(), message);
    await evaluate(() => fixture.mount(false, false));
    assert.equal(await evaluate(() => document.querySelector('[data-monitor-pr-ci]')), null, 'Ordinary items have no preset');
  }
  console.log('PASS Monitor PR CI browser smoke:', directory);
}
const watchdog = setTimeout(() => { console.error('Monitor PR CI smoke timed out'); app.exit(1); }, 45000);
run().then(() => { clearTimeout(watchdog); app.exit(0); }, error => { console.error(error, directory); clearTimeout(watchdog); app.exit(1); });
