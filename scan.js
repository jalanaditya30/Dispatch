// LR page: scan the QR code or barcode printed on an LR into the LR number box.
// Nothing here loads or starts until someone taps 📷, so the page itself stays as fast as before.
// Android Chrome reads codes natively; other phones (iPhone) fetch a small reader once, then it is cached.
const SCAN_LIB = 'https://cdn.jsdelivr.net/npm/barcode-detector@3.2.2/dist/iife/ponyfill.js';
const SCAN_FORMATS = ['qr_code', 'code_128', 'code_39', 'code_93', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf', 'codabar',
                      'data_matrix', 'pdf417', 'aztec'];
const canScan = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

let detectorP = null, scanStream = null, stopTimer = null, scanKey = null, scanLoop = null;

function getDetector() {
  if (detectorP) return detectorP;
  detectorP = (async () => {
    if ('BarcodeDetector' in window) {
      try {
        const have = await window.BarcodeDetector.getSupportedFormats();
        const f = SCAN_FORMATS.filter(x => have.includes(x));
        if (f.includes('qr_code') && f.includes('code_128')) return new window.BarcodeDetector({ formats: f });
      } catch (e) { /* fall through to the reader below */ }
    }
    if (!window.BarcodeDetectionAPI) {
      await new Promise((ok, bad) => {
        const s = document.createElement('script');
        s.src = SCAN_LIB; s.onload = ok; s.onerror = () => bad(new Error('Could not load the scanner. Check the internet and try again.'));
        document.head.appendChild(s);
      });
    }
    return new window.BarcodeDetectionAPI.BarcodeDetector({ formats: SCAN_FORMATS });
  })();
  detectorP.catch(() => { detectorP = null; });
  return detectorP;
}

// What in the scanned text is the LR number? Short plain codes are used as they are; for links and long
// text, the likely candidates are offered to tap.
function lrCandidates(raw) {
  const text = String(raw || '').trim();
  if (/^[A-Za-z0-9\-\/]{3,25}$/.test(text)) return [text];
  const out = [];
  const add = (v) => { v = String(v || '').trim(); if (v && !out.includes(v)) out.push(v); };
  try {
    const u = new URL(text);
    u.searchParams.forEach((v, k) => { if (/lr|docket|awb|cn|consign|track|bilty|grn|no/i.test(k) && /\d/.test(v)) add(v); });
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (last && /\d/.test(last) && last.length <= 25) add(decodeURIComponent(last));
  } catch (e) { /* not a link */ }
  (text.match(/[A-Za-z0-9\-\/]+/g) || [])
    .filter(t => /\d/.test(t) && t.length >= 4 && t.length <= 25 && !/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(t))   // skip dates
    .forEach(add);
  return out.slice(0, 8);
}

function scanUi() {
  let el = document.getElementById('scanBox');
  if (el) return el;
  document.body.insertAdjacentHTML('beforeend', `
<div class="scan-box" id="scanBox" hidden>
  <video id="scanVideo" playsinline muted></video>
  <div class="scan-frame"></div>
  <div class="scan-top"><span id="scanMsg">Point at the QR code or barcode on the LR</span></div>
  <div class="scan-pick" id="scanPick" hidden></div>
  <div class="scan-bar">
    <button class="scan-btn" id="scanTorch" hidden onclick="scanTorch()">🔦 Light</button>
    <button class="scan-btn close" onclick="closeScan()">✕ Close</button>
  </div>
</div>`);
  return document.getElementById('scanBox');
}

async function openScan(key) {
  scanKey = key;
  const box = scanUi(), video = document.getElementById('scanVideo');
  document.getElementById('scanPick').hidden = true;
  document.getElementById('scanMsg').textContent = 'Starting camera…';
  box.hidden = false;
  clearTimeout(stopTimer);
  const detP = getDetector();                       // loads while the camera starts
  try {
    if (!scanStream || !scanStream.active) {
      scanStream = await navigator.mediaDevices.getUserMedia({
        audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
    }
    video.srcObject = scanStream;
    await video.play();
    const track = scanStream.getVideoTracks()[0];
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps.focusMode && caps.focusMode.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    document.getElementById('scanTorch').hidden = !caps.torch;
    document.getElementById('scanMsg').textContent = 'Point at the QR code or barcode on the LR';
    const det = await detP;
    if (scanKey !== key || box.hidden) return;
    runScan(det, video, key);
  } catch (e) {
    closeScan(true);
    toast(e.name === 'NotAllowedError' ? 'Allow the camera for this site to scan' : (e.message || 'Camera not available'), 'err');
  }
}

function runScan(det, video, key) {
  clearTimeout(scanLoop);
  const tick = async () => {
    const box = document.getElementById('scanBox');
    if (box.hidden || scanKey !== key) return;
    try {
      if (video.readyState >= 2) {
        const found = await det.detect(video);
        const hit = found.find(b => b.rawValue);
        if (hit) { gotScan(hit.rawValue, key); return; }
      }
    } catch (e) { /* frame not ready; try the next one */ }
    scanLoop = setTimeout(tick, 120);
  };
  tick();
}

function gotScan(raw, key) {
  if (navigator.vibrate) navigator.vibrate(60);
  const c = lrCandidates(raw);
  if (c.length === 1) { useScan(key, c[0]); return; }
  const pick = document.getElementById('scanPick');
  pick.innerHTML = `<div class="scan-pick-title">${c.length ? 'Tap the LR number' : 'No LR number found in this code'}</div>
    ${c.map(v => `<button class="scan-cand" onclick="useScan('${esc(key)}', this.textContent)">${esc(v.toUpperCase())}</button>`).join('')}
    <div class="scan-raw">${esc(String(raw).slice(0, 300))}</div>
    <button class="scan-btn" onclick="openScan('${esc(key)}')">↻ Scan again</button>`;
  pick.hidden = false;
  document.getElementById('scanMsg').textContent = 'Scanned';
}

function useScan(key, value) {
  const lr = upLr(value);
  closeScan();
  if (typed[key]) typed[key].lr = lr;
  const input = document.getElementById('lr-' + key);
  if (input) { input.value = lr; input.classList.remove('required-err'); }
  const btn = document.getElementById('ls-' + key);
  if (btn) { btn.classList.add('ready'); btn.focus({ preventScroll: true }); btn.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  toast('Scanned ' + lr + ' · check it, then tap Save', 'ok');
}

function closeScan(now) {
  const box = document.getElementById('scanBox');
  if (box) box.hidden = true;
  clearTimeout(scanLoop);
  scanKey = null;
  // keep the camera warm for a short while, so the next LR scans instantly
  clearTimeout(stopTimer);
  stopTimer = setTimeout(stopCamera, now ? 0 : 20000);
}
function stopCamera() {
  if (scanStream) scanStream.getTracks().forEach(t => t.stop());
  scanStream = null;
}
function scanTorch() {
  const track = scanStream && scanStream.getVideoTracks()[0];
  if (!track) return;
  const on = !track.getSettings().torch;
  track.applyConstraints({ advanced: [{ torch: on }] }).catch(() => {});
}
document.addEventListener('visibilitychange', () => { if (document.hidden) { closeScan(true); } });
