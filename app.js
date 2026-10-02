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
const coClass = (company) => 'co-' + String(company || '').replace(/\s+/g, '');
const byName = (a, b) => a.party.localeCompare(b.party, 'en', { sensitivity: 'base' });

async function api(params) {
  const q = new URLSearchParams(params);
  const r = await fetch(SCRIPT_URL + '?' + q.toString(), { redirect: 'follow' });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('Sheet did not answer properly. Tap refresh to retry.'); }
  return data;
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
  if (cached) use(cached);   // show the last board at once; the fresh one replaces it when it arrives
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
  } finally { spin(false); }
}

// Outbox: a save is shown on screen straight away and sent to the sheet in the background, one at a time.
// It is kept on the device, so closing the page or losing signal does not lose it; it is sent on the next open.
const OUTBOX_KEY = 'outbox:' + location.pathname;
let outbox = (() => { try { return JSON.parse(store.get(OUTBOX_KEY)) || []; } catch (e) { return []; } })();
let sending = false, writeGen = 0, retryTimer;
const MAX_TRIES = 6;

function saveOutbox() { store.set(OUTBOX_KEY, JSON.stringify(outbox)); updatePending(); }
function updatePending() {
  const el = $('syncPill');
  if (!el) return;
  el.hidden = !outbox.length;
  el.textContent = '⏳ Saving ' + outbox.length;
}
const isSaving = (key) => outbox.some(op => op.params.key === key || String(op.params.keys || '').split(',').includes(key));

function enqueue(params, label, local) {
  const op = { params, label, local: local || {}, tries: 0 };
  outbox.push(op); saveOutbox();
  applyOp(op);
  flush();
}
function applyPending() { outbox.forEach(applyOp); }

async function flush() {
  if (sending || !outbox.length) return;
  sending = true; clearTimeout(retryTimer);
  let wrote = false;
  try {
    while (outbox.length) {
      const op = outbox[0];
      let res;
      try { res = await api(op.params); } catch (e) {
        // No signal or the sheet is busy: keep it and try again shortly.
        op.tries++;
        if (op.tries < MAX_TRIES) {
          saveOutbox(); setDot('err', 'Not saved yet, retrying');
          retryTimer = setTimeout(flush, Math.min(30000, 2000 * 2 ** op.tries));
          return;
        }
        res = { ok: false, error: e.message };
      }
      outbox.shift(); saveOutbox(); writeGen++; wrote = true;
      if (!res.ok) toast(op.label + ' NOT saved: ' + (res.error || 'error'), 'err');
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
