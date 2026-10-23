/* SnapDust - isolated content script.
   Hosts the ML worker, bridges frames to/from the MAIN-world interceptor,
   clicks Meet's own mic button so Meet's mute state stays truthful, and
   renders the small status pill. */
(() => {
  if (window.__snapdustContent) return;
  window.__snapdustContent = true;
  const LOG = (...a) => console.log('[SnapDust]', ...a);

  /* ---- Platform adapters. Meet is live; Teams/Zoom/Webex plug in here later
     (their manifest matches + mic-button selectors). ---- */
  const PLATFORMS = {
    'meet.google.com': {
      name: 'Google Meet',
      micButton() {
        return document.querySelector('button[aria-label*="microphone" i]');
      },
      isMuted(btn) {
        const label = (btn.getAttribute('aria-label') || '').toLowerCase();
        if (label.includes('turn on microphone')) return true;
        if (label.includes('turn off microphone')) return false;
        return btn.getAttribute('aria-pressed') === 'false';
      }
    }
  };
  const platform = PLATFORMS[location.hostname] || null;

  let weMuted = false;
  function handleMic(action) {
    if (!platform) return;
    const btn = platform.micButton();
    if (!btn) { LOG('mic button not found (Meet UI not loaded yet?)'); return; }
    const muted = platform.isMuted(btn);
    if (action === 'mute') {
      if (!muted) { btn.click(); weMuted = true; LOG('mic muted'); }
    } else if (action === 'unmute') {
      if (muted && weMuted) { btn.click(); LOG('mic unmuted'); }
      weMuted = false;
    }
  }

  /* ---- ML via the background service worker ----
     Meet enforces Trusted Types, which blocks loading extension scripts in
     page-origin workers. So inference runs in an offscreen document on the
     extension's own origin (created by the service worker) - no page policy
     is touched. Frames and masks travel as base64 because chrome.runtime
     messaging is JSON-only. */
  let workerReady = false;
  let inflight = false;
  let extDead = false;
  let failStreak = 0;
  let initTimer = null;
  // Frame ids are namespaced per tab so two Meet tabs sharing one offscreen
  // document can never collide in its pending map.
  const tabToken = Math.random().toString(36).slice(2, 10);
  function handleExtDead() {
    if (extDead) return;
    extDead = true;
    LOG('extension context invalidated; page keeps its camera, effects off until reload');
    setPill('SnapDust: reload page to re-enable', 'err');
    window.postMessage({ __snapdust: true, type: 'ext-dead' }, location.origin);
  }
  // chrome.runtime calls throw once the extension context is invalidated
  // (extension reload/update while this page is alive). Degrade gracefully:
  // the page keeps its camera through the raw passthrough, only effects die.
  function safeSend(msg, cb) {
    if (extDead) { if (cb) cb(null, new Error('ext dead')); return; }
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        const err = chrome.runtime.lastError;
        if (err && String(err.message || err).includes('invalidated')) { handleExtDead(); if (cb) cb(null, err); return; }
        if (cb) cb(resp, err || null);
      });
    } catch (e) {
      if (String(e).includes('invalidated')) handleExtDead();
      if (cb) cb(null, e);
    }
  }
  function ensureWorker() {
    if (workerReady) return;
    setPill('SnapDust starting...', 'busy');
    // Ask the service worker to create the offscreen ML document; readiness
    // arrives separately as an ml-ready broadcast once models have loaded.
    // ML runs on the CPU delegate by default (stable everywhere). GPU is an
    // opt-in perf experiment: localStorage __sd_force_gpu=1.
    let forceGpu = false;
    try { forceGpu = localStorage.getItem('__sd_force_gpu') === '1'; } catch (e) {}
    safeSend({ sd: true, type: 'init', forceGpu }, (resp, err) => {
      if (err || !resp || !resp.ok) {
        if (!extDead) {
          const why = String((err && (err.message || err)) || (resp && resp.error) || 'unknown');
          LOG('ML host start failed:', why);
          setPill('SnapDust restarting...', 'busy');
          if (pill) pill.title = 'Last startup error: ' + why;
          // Never park on a dead error: retry until the runtime comes up.
          if (!initTimer) initTimer = setTimeout(() => { initTimer = null; ensureWorker(); }, 4000);
        }
      }
    });
  }
  // runtime.sendMessage does not reach content scripts, so readiness is
  // inferred from the first successful frame response instead of a broadcast.
  function noteReady() {
    if (workerReady) return;
    workerReady = true;
    setPill('SnapDust ready', 'on');
    LOG('ML ready (offscreen extension worker)');
    window.postMessage({ __snapdust: true, type: 'ml-alive' }, location.origin);
  }

  function u8ToB64(u8) {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  }
  function b64ToU8(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  function sendFrame(d) {
    if (inflight) return; // one at a time; inject retries anyway
    inflight = true;
    safeSend({
      sd: true, type: 'frame', id: tabToken + ':' + d.id, ts: d.ts,
      wantHands: d.wantHands, wantMask: d.wantMask,
      w: d.w, h: d.h, pixels: u8ToB64(d.pixels)
    }, (resp, err) => {
      inflight = false;
      if (resp && resp.delegate) window.postMessage({ __snapdust: true, type: 'ml-delegate', delegate: resp.delegate }, location.origin);
      if (resp && resp.dead) {
        // ML wedged or restarting: page switches to raw camera passthrough.
        window.postMessage({ __snapdust: true, type: 'ml-dead' }, location.origin);
        window.postMessage({ __snapdust: true, type: 'ml-result', id: d.id, ts: d.ts, hands: null, mask: null }, location.origin);
        setPill('SnapDust: camera only (effects restarting)', 'err');
        return;
      }
      if (resp && !resp.dropped && !resp.error) { failStreak = 0; noteReady(); }
      if (err || !resp || resp.error || resp.dropped) {
        if (resp && resp.error) LOG('ML error:', resp.error);
        // Hard failures (dead offscreen, port closed) re-arm startup so the
        // service worker health-checks and recreates the ML document.
        if ((err || !resp || resp.error) && !extDead && ++failStreak >= 8) {
          failStreak = 0;
          workerReady = false;
          LOG('ML unreachable; requesting restart');
          ensureWorker();
        }
        // keep the MAIN-world pump unblocked
        window.postMessage({ __snapdust: true, type: 'ml-result', id: d.id, ts: d.ts, hands: null, mask: null }, location.origin);
        return;
      }
      let mask = null;
      if (resp.maskB64) {
        const alpha = b64ToU8(resp.maskB64);
        const img = new ImageData(resp.mw, resp.mh);
        const px = img.data;
        for (let i = 0; i < alpha.length; i++) {
          const o = i * 4;
          px[o] = 255; px[o + 1] = 255; px[o + 2] = 255; px[o + 3] = alpha[i];
        }
        const oc = new OffscreenCanvas(resp.mw, resp.mh);
        oc.getContext('2d').putImageData(img, 0, 0);
        mask = oc.transferToImageBitmap();
      }
      window.postMessage(
        { __snapdust: true, type: 'ml-result', id: d.id, ts: d.ts, hands: resp.hands || null, mask },
        location.origin, mask ? [mask] : []);
    });
  }

  /* ---- bridge from MAIN world ---- */
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || d.__snapdust !== true) return;
    if (d.type === 'frame') {
      // Drop frames until the SW is up. Frames arrive as raw pixels
      // (cross-world postMessage strips ImageBitmaps; typed arrays survive).
      if (d.pixels) sendFrame(d); // offscreen returns {dropped} until models load
    } else if (d.type === 'hello') {
      ensureWorker();
    } else if (d.type === 'mic') {
      handleMic(d.action);
    } else if (d.type === 'cal-state') {
      handleCalState(d);
    } else if (d.type === 'fx-state') {
      if (d.state === 'gone') setPill('SnapDust: dusted', 'dust');
      else if (d.state === 'ready') setPill('SnapDust ready', 'on');
      else if (d.state === 'raw') setPill('SnapDust: camera only (effects paused)', 'err');
    }
  });

  /* ---- status pill + manual triggers ---- */
  let pill;
  let calibrated = false;   // a clean backdrop has been captured this session
  let calBusy = false;
  let previewDiv;
  function makePill() {
    if (pill) return;
    pill = document.createElement('button');
    pill.id = 'snapdust-pill';
    pill.textContent = 'SnapDust';
    Object.assign(pill.style, {
      position: 'fixed', right: '14px', bottom: '86px', zIndex: 99999,
      padding: '7px 12px', borderRadius: '16px', border: 'none',
      background: '#3c4043', color: '#e8eaed',
      font: '500 12px Roboto, Arial, sans-serif', cursor: 'pointer',
      opacity: 0.85, boxShadow: '0 1px 3px rgba(0,0,0,.4)',
      transition: 'transform .15s ease'
    });
    pill.title = 'SnapDust: snap your fingers on camera, click this, or press Alt+S. Alt+B recaptures the backdrop.';
    pill.addEventListener('click', () => {
      // Uncalibrated: the click starts backdrop capture. Calibrated: toggle.
      window.postMessage({ __snapdust: true, type: calibrated ? 'snapdust-toggle' : 'snapdust-calibrate' }, location.origin);
      flashPill();
    });
    document.documentElement.appendChild(pill);
  }
  function hidePreview() {
    if (previewDiv) { previewDiv.remove(); previewDiv = null; }
  }
  function showPreview(dataUrl) {
    hidePreview();
    previewDiv = document.createElement('div');
    previewDiv.id = 'snapdust-preview';
    Object.assign(previewDiv.style, {
      position: 'fixed', right: '14px', bottom: '120px', zIndex: 99999,
      background: '#202124', padding: '10px', borderRadius: '10px',
      boxShadow: '0 2px 10px rgba(0,0,0,.5)', color: '#e8eaed',
      font: '12px Roboto, Arial, sans-serif', textAlign: 'center', width: '260px'
    });
    const img = document.createElement('img');
    img.src = dataUrl;
    Object.assign(img.style, { width: '240px', borderRadius: '6px', display: 'block', margin: '0 auto 8px' });
    const label = document.createElement('div');
    label.textContent = 'Backdrop captured. This is what others see while you are dusted.';
    label.style.marginBottom = '8px';
    const btnStyle = { padding: '5px 12px', margin: '0 4px', borderRadius: '12px', border: 'none', cursor: 'pointer', font: '500 12px Roboto, Arial, sans-serif' };
    const ok = document.createElement('button');
    ok.textContent = 'Looks good';
    Object.assign(ok.style, btnStyle, { background: '#1e8e3e', color: '#fff' });
    ok.addEventListener('click', hidePreview);
    const re = document.createElement('button');
    re.textContent = 'Recapture';
    Object.assign(re.style, btnStyle, { background: '#3c4043', color: '#e8eaed' });
    re.addEventListener('click', () => {
      hidePreview();
      window.postMessage({ __snapdust: true, type: 'snapdust-calibrate' }, location.origin);
    });
    previewDiv.append(img, label, ok, re);
    document.documentElement.appendChild(previewDiv);
  }
  function handleCalState(d) {
    if (d.state === 'needed') {
      setPill('SnapDust: set backdrop first', 'busy');
      setTimeout(() => { if (!calibrated && !calBusy) setPill('SnapDust: set backdrop', ''); }, 2500);
    } else if (d.state === 'countdown') {
      calBusy = true;
      setPill('Step out of frame! Capturing in ' + d.n, 'busy');
    } else if (d.state === 'verifying') {
      setPill('SnapDust: checking frame...', 'busy');
    } else if (d.state === 'captured') {
      calBusy = false;
      calibrated = true;
      setPill('SnapDust ready', 'on');
      if (d.preview) showPreview(d.preview);
    } else if (d.state === 'failed') {
      calBusy = false;
      calibrated = false;
      const why = d.reason === 'person' ? 'Person still in frame - step out fully'
        : d.reason === 'no-mask' ? 'Still starting up - click to retry'
        : d.reason === 'ml-down' ? 'Effects unavailable - camera only'
        : 'Capture failed - click to retry';
      // Sticky: the reason stays visible until the user acts. A 3s auto-hide
      // made failures look like nothing happened.
      setPill('SnapDust: ' + why, 'err');
    }
  }
  function setPill(text, cls) {
    if (!pill) makePill();
    pill.textContent = text;
    pill.style.background =
      cls === 'on' ? '#1e8e3e' : cls === 'dust' ? '#7b1fa2' :
      cls === 'err' ? '#d93025' : cls === 'busy' ? '#e37400' : '#3c4043';
  }
  function flashPill() {
    if (!pill) return;
    pill.style.transform = 'scale(1.15)';
    setTimeout(() => { pill.style.transform = ''; }, 160);
  }
  makePill();
  setPill('SnapDust: set backdrop', '');
  window.addEventListener('keydown', (e) => {
    if (e.altKey && e.code === 'KeyS') {
      e.preventDefault();
      window.postMessage({ __snapdust: true, type: calibrated ? 'snapdust-toggle' : 'snapdust-calibrate' }, location.origin);
      flashPill();
    } else if (e.altKey && e.code === 'KeyB') {
      e.preventDefault();
      window.postMessage({ __snapdust: true, type: 'snapdust-calibrate' }, location.origin);
      flashPill();
    }
  }, true);
})();
