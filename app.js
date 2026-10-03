// Shared by the Gate Dispatch page and the LR Entry page.
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxA72zSFHxypMyC92C8Xf6bFzaOmucPdBu08tYnTuzeU1X9ZosZ82kdJbyDpvqUZR11/exec';
const OLD_SCRIPT = 'The Google Sheet is running an old script. In Apps Script: Deploy > Manage deployments > pencil > New version.';

const store = {
  mem: {},
  get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return store.mem[k] || ''; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { store.mem[k] = v; } }
};
// The last list is kept on the device, so the page shows something at once and then freshens it.
const snap = {
  load(k) { try { return JSON.parse(localStorage.getItem('snap:' + k) || 'null'); } catch (e) { return null; } },
  save(k, d) { try { localStorage.setItem('snap:' + k, JSON.stringify(d)); } catch (e) { } }
};
const todayLocal = () => { const n = new Date(); return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0'); };
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
function startApp() {
  startClock();
  $('whoBtn').textContent = store.get('name') || 'Sign in';
  if (!store.get('name')) showGate(''); else loadData();
}
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
