// Shared by the Dispatch page and the LR page.
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxA72zSFHxypMyC92C8Xf6bFzaOmucPdBu08tYnTuzeU1X9ZosZ82kdJbyDpvqUZR11/exec';

const store = {
  get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return store.mem[k] || ''; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { store.mem[k] = v; } },
  mem: {}
};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(params) {
  const q = new URLSearchParams(Object.assign({ pin: store.get('pin') }, params));
  const r = await fetch(SCRIPT_URL + '?' + q.toString(), { redirect: 'follow' });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('Sheet did not answer properly. Try again.'); }
  if (!data.ok && data.error === 'wrong PIN') { store.set('pin', ''); showGate('Wrong PIN. Try again.'); }
  return data;
}

function toast(msg, isErr) {
  const el = $('toast');
  el.textContent = msg; el.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => { el.className = 'toast'; }, 2600);
}

// Name + PIN, asked once per phone/computer.
function showGate(message) {
  $('gate').style.display = 'flex';
  $('gateErr').textContent = message || '';
  $('gateName').value = store.get('name');
  $('gatePin').value = '';
  ($('gateName').value ? $('gatePin') : $('gateName')).focus();
}
function gateSubmit(ev) {
  ev.preventDefault();
  const name = $('gateName').value.trim(), pin = $('gatePin').value.trim();
  if (!name || !pin) { $('gateErr').textContent = 'Enter your name and the team PIN.'; return; }
  store.set('name', name); store.set('pin', pin);
  $('gate').style.display = 'none';
  $('who').textContent = name;
  load();
}
function startApp() {
  $('who').textContent = store.get('name') || 'Sign in';
  if (!store.get('name') || !store.get('pin')) showGate(''); else load();
}
function daysSince(text) {
  const t = Date.parse(String(text || '').replace(' ', 'T'));
  return isNaN(t) ? 0 : (Date.now() - t) / 86400000;
}
