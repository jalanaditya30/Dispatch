// Shared by the Gate Dispatch page and the LR Entry page.
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxA72zSFHxypMyC92C8Xf6bFzaOmucPdBu08tYnTuzeU1X9ZosZ82kdJbyDpvqUZR11/exec';
const OLD_SCRIPT = 'The Google Sheet is running an old script. In Apps Script: Deploy > Manage deployments > pencil > New version.';

const store = {
  mem: {},
  get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return store.mem[k] || ''; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { store.mem[k] = v; } }
};
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
const coClass = (company) => 'co-' + String(company || '').replace(/[^A-Za-z0-9]/g, '');
const byName = (a, b) => a.party.localeCompare(b.party, 'en', { sensitivity: 'base' });

// Never redraw the list under someone's fingers: if a box in the list is being typed in, wait until they leave it.
let renderWaiting = false;
function safeRender() {
  const a = document.activeElement, list = $('list');
  if (a && list && list.contains(a) && /INPUT|SELECT|TEXTAREA/.test(a.tagName)) {
    // (a little later than the blur, so a tap or click on Save / Dispatch is not lost under the redraw)
    if (!renderWaiting) { renderWaiting = true; a.addEventListener('blur', () => { setTimeout(() => { renderWaiting = false; render(); }, 350); }, { once: true }); }
    return;
  }
  render();
}
let soonTimer;
function renderSoon() { clearTimeout(soonTimer); soonTimer = setTimeout(render, 160); }   // search: wait until typing pauses

const NO_REPLY = 'Cannot reach the Google Sheet script. Open the script link in a browser: it should show "version". Retrying by itself…';
async function api(params) {
  const q = new URLSearchParams(params);
  // Never wait for ever: a call the sheet has not answered in 25 s counts as failed (saves are retried).
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl && setTimeout(() => ctl.abort(), 25000);
  let text;
  try {
    const r = await fetch(SCRIPT_URL + '?' + q.toString(), { redirect: 'follow', signal: ctl ? ctl.signal : undefined });
    text = await r.text();
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'The sheet took too long to answer. Retrying by itself…' : NO_REPLY);
  } finally { clearTimeout(timer); }
  try { return JSON.parse(text); } catch (e) { throw new Error('Sheet did not answer properly. Tap refresh to retry.'); }
}

function startClock() {
  const el = $('clock');
  const t = () => { const n = new Date(); el.textContent = pad(n.getHours()) + ':' + pad(n.getMinutes()); };
  t(); setInterval(t, 10000);
}
function setDot(state, msg) {
  const dot = $('statusDot');
  dot.className = 'status-dot' + (state === 'ok' ? ' ok' : state === 'err' ? ' err' : '');
  dot.title = msg || '';
}
function spin(v) { $('refreshBtn').classList.toggle('spin', v); }

let toastTimer;
function toast(msg, type) {
  const el = $('toast');
  el.textContent = msg; el.className = 'toast ' + (type || 'ok') + ' show';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

// The person's name, asked once per phone or computer, so the sheet records who did what.
function showGate(message) {
  $('gate').style.display = 'flex';
  $('gateErr').textContent = message || '';
  $('gateName').value = store.get('name');
  $('gateName').focus();
}
function gateSubmit(ev) {
  ev.preventDefault();
  const name = $('gateName').value.trim();
  if (!name) { $('gateErr').textContent = 'Enter your name.'; return; }
  store.set('name', name);
  $('gate').style.display = 'none';
  $('whoBtn').textContent = name;
  loadData();
}
// The page hands over which board it shows and how to take it in (records + any saves not yet sent).
let board = { view: '', use: null };
function startApp(view, use) {
  board = { view, use };
  startClock();
  $('statusDot').insertAdjacentHTML('afterend', '<span class="sync-pill" id="syncPill" hidden></span>');
  updatePending();
  $('whoBtn').textContent = store.get('name') || 'Sign in';
  const cached = cachedBoard(view);
  if (cached) { try { use(cached); } catch (e) { } }   // show the last board at once; the fresh one replaces it when it arrives
  flush();
  if (!store.get('name')) showGate(''); else loadData();
}

// Last board this device saw today, so opening the page does not wait on the sheet.
const today = () => new Date().toLocaleDateString('en-CA');
function cacheBoard(view, d) { store.set('board:' + view, JSON.stringify({ day: today(), d })); }
function cachedBoard(view) {
  try { const c = JSON.parse(store.get('board:' + view)); return c && c.day === today() ? c.d : null; } catch (e) { return null; }
}

async function loadData() {
  clearTimeout(reloadTimer);
  setDot('load'); spin(true);
  const gen = writeGen;
  try {
    const d = await api(board.view ? { action: 'board', view: board.view } : { action: 'board' });
    if (!d.ok) throw new Error(d.error || 'Load failed');
    if (!Array.isArray(d.records)) throw new Error(OLD_SCRIPT);
    // A save landed while this was loading, so this board may predate it; the reload after the save is fresher.
    if (gen !== writeGen) return;
    cacheBoard(board.view, d);
    board.use(d);
    setDot(outbox.length ? 'load' : 'ok', 'Connected');
  } catch (e) {
    setDot('err', e.message);
    if (!records.length) $('list').innerHTML = connectionError(e.message);
    else toast(e.message, 'err');
    clearTimeout(reloadTimer); reloadTimer = setTimeout(loadData, 15000);   // try again by itself
  } finally { spin(false); }
}
let reloadTimer;

// Outbox: a save is shown on screen straight away and sent to the sheet in the background, one at a time.
// It is kept on the device, so closing the page or losing signal does not lose it; it is sent on the next open.
// One queue per page type (gate / lr), whatever address the page was opened with.
const PAGE_KIND = /lr\.html$/i.test(location.pathname) ? 'lr' : /godown\.html$/i.test(location.pathname) ? 'godown' : 'gate';
const OUTBOX_KEY = 'outbox2:' + PAGE_KIND;
let outbox = (() => {
  let list = [];
  try { list = JSON.parse(store.get(OUTBOX_KEY)) || []; } catch (e) { }
  // saves left by the earlier version of this page (kept under the page address) are picked up too
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || k.indexOf('outbox:') !== 0) continue;
      const path = k.substring(7), kind = /lr\.html$/i.test(path) ? 'lr' : /godown\.html$/i.test(path) ? 'godown' : 'gate';
      if (kind !== PAGE_KIND) continue;
      try { (JSON.parse(localStorage.getItem(k)) || []).forEach(op => { if (!list.some(x => x.params.op === op.params.op)) list.push(op); }); } catch (e) { }
      localStorage.removeItem(k); i--;
    }
    if (list.length) localStorage.setItem(OUTBOX_KEY, JSON.stringify(list));
  } catch (e) { }
  return list;
})();
let sending = false, writeGen = 0, retryTimer;

function saveOutbox() { store.set(OUTBOX_KEY, JSON.stringify(outbox)); updatePending(); }

// A red bar that stays until tapped: a save the sheet refused, or saves that have not reached the sheet for a while.
const problems = [];
function showProblem(msg) {
  problems.push(msg);
  let el = $('problemBar');
  if (!el) {
    document.body.insertAdjacentHTML('afterbegin', '<div id="problemBar" onclick="problems.length=0;this.remove()" style="position:sticky;top:0;z-index:300;background:#b91c1c;color:#fff;padding:10px 14px;font:600 14px Inter,system-ui,sans-serif;cursor:pointer"></div>');
    el = $('problemBar');
  }
  el.innerHTML = problems.slice(-4).map(esc).join('<br>') + '<div style="font-weight:400;font-size:12px;opacity:.85;margin-top:4px">Tap to close</div>';
}
function updatePending() {
  const el = $('syncPill');
  if (!el) return;
  el.hidden = !outbox.length;
  el.textContent = '⏳ Saving ' + outbox.length;
}
const isSaving = (key) => outbox.some(op => op.params.key === key || String(op.params.keys || '').split(',').includes(key));

function enqueue(params, label, local) {
  // "op" names this one save, so the sheet can tell a resend (after a lost reply) from a new save.
  params.op = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const op = { params, label, local: local || {}, tries: 0 };
  outbox.push(op); saveOutbox();
  try { applyOp(op); } catch (e) { }
  flush();
}
function applyPending() { outbox.forEach(op => { try { applyOp(op); } catch (e) { } }); }

async function flush() {
  if (sending || !outbox.length) return;
  sending = true; clearTimeout(retryTimer);
  let wrote = false;
  try {
    while (outbox.length) {
      const op = outbox[0];
      let res;
      try { res = await api(op.params); } catch (e) { res = { busy: true }; }
      // the sheet answered "busy" with a real error many times in a row: stop and say so, instead of retrying for ever
      if (res.busy && res.error && !/busy/i.test(res.error)) {
        op.serverErrs = (op.serverErrs || 0) + 1;
        if (op.serverErrs >= 8) res = { ok: false, error: res.error };
      }
      if (res.busy) {
        // No signal, or the sheet is busy with other saves: keep it and try again shortly.
        // Resending is safe, the sheet ignores a save it has already done.
        op.tries++; saveOutbox(); setDot('err', 'Not saved yet, retrying');
        op.since = op.since || Date.now();
        if (!op.warned && Date.now() - op.since > 3 * 60000) {
          op.warned = true; saveOutbox();
          showProblem('⚠ ' + outbox.length + ' save(s) have not reached the Google Sheet for 3 minutes (' + op.label + '). Keep this page open - it keeps trying. Check the internet.');
        }
        retryTimer = setTimeout(flush, Math.min(30000, 1000 * 2 ** op.tries));
        return;
      }
      outbox.shift(); writeGen++; wrote = true;
      if (!res.ok) {
        // refused for good (e.g. another phone dispatched it first): later saves for the same bill are dropped too
        const keys = [op.params.key].concat(String(op.params.keys || '').split(',')).filter(Boolean);
        const dropped = outbox.filter(o => [o.params.key].concat(String(o.params.keys || '').split(',')).some(k => keys.includes(k)));
        outbox = outbox.filter(o => !dropped.includes(o));
        showProblem('✗ ' + op.label + ' NOT saved: ' + (res.error || 'error') + (dropped.length ? ' (and ' + dropped.length + ' later change(s) to it)' : ''));
        // the screen showed it as done: put it back as it was (the board reload after this shows the sheet's own state)
        if (op.params.action === 'dispatch') { try { applyOp({ params: { action: 'undo', key: op.params.key }, local: {} }); } catch (e) { } }
      }
      saveOutbox();
    }
  } finally {
    sending = false;
    if (wrote && !outbox.length) loadData();   // all saves are in: show the sheet's own view once
  }
}
window.addEventListener('online', flush);
window.addEventListener('beforeunload', (e) => { if (outbox.length) { flush(); e.preventDefault(); e.returnValue = ''; } });

function connectionError(msg) {
  return `<div class="empty"><div class="empty-icon">📵</div><div class="empty-title">Connection error</div>
    <div class="empty-sub" style="font-size:12px;word-break:break-word;max-width:320px;margin:0 auto">${esc(msg)}</div>
    <div style="margin-top:16px;font-size:12px;color:var(--t3)">Tap ↻ to retry</div></div>`;
}
const GATE_HTML = `<div class="gate" id="gate" style="display:none"><form onsubmit="gateSubmit(event)">
  <h2>Your name</h2><p>Asked once on this device.</p>
  <input class="t-input" id="gateName" placeholder="Your name" autocomplete="name">
  <div class="gate-err" id="gateErr"></div>
  <button class="disp-btn" type="submit" style="margin-top:6px">Continue</button></form></div>
  <div class="toast" id="toast"></div>`;
