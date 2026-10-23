/* SnapDust offscreen document: owns the ML worker (extension origin, so no
   page Trusted Types policy applies) and relays frames/results between the
   content script (JSON/base64 over runtime messaging) and the worker
   (structured clone + transfer). */
console.log('[SnapDust OFFSCREEN] boot');
const forceGpu = new URLSearchParams(location.search).get('gpu') === '1';
const worker = new Worker('ml-worker.js');
let ready = false;
let mlDead = false;
let delegate = null;
let timeoutStreak = 0;
function declareDead(why) {
  if (mlDead) return;
  mlDead = true;
  ready = false;
  console.log('[SnapDust OFFSCREEN] declaring ML dead:', why);
  chrome.runtime.sendMessage({ sd: true, type: 'ml-dead' });
}
worker.onerror = (e) => {
  console.log('[SnapDust OFFSCREEN] worker error', e.message, e.filename, e.lineno);
  // A hard wasm abort leaves the worker alive but unable to ever answer
  // again; treat a worker error as fatal for this document.
  declareDead('worker error: ' + (e.message || 'unknown'));
};

worker.onmessage = (ev) => {
  const d = ev.data;
  console.log('[SnapDust OFFSCREEN] worker msg', d.type);
  if (d.type === 'ready') {
    ready = true;
    delegate = d.delegate || null;
    console.log('[SnapDust OFFSCREEN] models ready, delegate:', delegate);
    chrome.runtime.sendMessage({ sd: true, type: 'ml-ready' });
  } else if (d.type === 'dead') {
    // The worker gave up after repeated inference failures. Ask the service
    // worker to recreate this document with a fresh wasm runtime.
    declareDead('worker self-reported');
  }
};

/* Pending frame resolvers keyed by frame id. A resolver never waits forever:
   a wedged worker must not hang the content script's frame pump. */
const pending = new Map();
worker.addEventListener('message', (ev) => {
  const d = ev.data;
  if (d.type !== 'result') return;
  const ent = pending.get(d.id);
  if (!ent) return;
  pending.delete(d.id);
  clearTimeout(ent.timer);
  timeoutStreak = 0;
  const res = ent.resolve;
  if (d.dead) { res({ dead: true }); return; }
  (async () => {
    try {
      const out = {};
      if (delegate) out.delegate = delegate;
      if (d.hands) out.hands = d.hands;
      if (d.mask) {
        const w = d.mask.width, h = d.mask.height;
        const oc = new OffscreenCanvas(w, h);
        const ctx = oc.getContext('2d');
        ctx.drawImage(d.mask, 0, 0);
        const img = ctx.getImageData(0, 0, w, h);
        const alpha = new Uint8Array(w * h);
        for (let i = 0; i < alpha.length; i++) alpha[i] = img.data[i * 4 + 3];
        out.maskB64 = u8ToB64(alpha);
        out.mw = w; out.mh = h;
        d.mask.close();
      }
      res(out);
    } catch (e) {
      res({ error: String(e) });
    }
  })();
});

function b64ToU8(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
function u8ToB64(u8) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.sd !== true) return false;
  // Health probe from the service worker: proves this document AND its
  // message loop are alive, and reports ML state.
  if (msg.type === 'ping') {
    sendResponse({ ok: true, ready, dead: mlDead, delegate });
    return false;
  }
  if (msg.type !== 'frame') return false;
  if (mlDead) { sendResponse({ dead: true }); return false; }
  if (!ready) { sendResponse({ dropped: true }); return false; }
  (async () => {
    try {
      const rgba = b64ToU8(msg.pixels);
      const oc = new OffscreenCanvas(msg.w, msg.h);
      oc.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, 0, msg.w * msg.h * 4), msg.w, msg.h), 0, 0);
      const bitmap = oc.transferToImageBitmap();
      const resultPromise = new Promise((res) => {
        const timer = setTimeout(() => {
          pending.delete(msg.id);
          // The worker accepted frames but stopped answering: it is a
          // zombie (classic after a wasm abort). Three in a row -> rebuild.
          if (++timeoutStreak >= 3) declareDead('3 consecutive frame timeouts');
          res({ error: 'ml timeout' });
        }, 4000);
        pending.set(msg.id, { resolve: res, timer });
      });
      worker.postMessage({ type: 'frame', id: msg.id, ts: msg.ts, wantHands: msg.wantHands, wantMask: msg.wantMask, bitmap }, [bitmap]);
      sendResponse(await resultPromise);
    } catch (e) {
      sendResponse({ error: String(e) });
    }
  })();
  return true;
});

worker.postMessage({
  type: 'init',
  bundleUrl: chrome.runtime.getURL('vendor/vision_bundle.js'),
  wasmBase: chrome.runtime.getURL('vendor/wasm'),
  handUrl: chrome.runtime.getURL('models/hand_landmarker.task'),
  segUrl: chrome.runtime.getURL('models/selfie_segmenter.tflite'),
  forceGpu
});
