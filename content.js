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
  let micExpected = null;   // what we asked Meet's mic to become, until verified
  let micWarn = false;
  // Observed Meet mic state, read from Meet's own button. 'unknown' when
  // the button can't be found; never inferred from our own click.
  function micState() {
    if (!platform) return 'unknown';
    const btn = platform.micButton();
    if (!btn) return 'unknown';
    return platform.isMuted(btn) ? 'muted' : 'live';
  }
  function checkMicAfter(expected) {
    micExpected = expected;
    micWarn = false;
    setTimeout(() => {
      // Re-evaluated on every render from Meet's actual button: a late
      // update (slow click) clears the warning by itself.
      micWarn = micState() !== micExpected;
      if (micWarn) LOG('mic state after', expected, 'attempt is', micState());
      renderPill();
    }, 800);
  }
  function handleMic(action) {
    if (!platform) return;
    const btn = platform.micButton();
    if (!btn) { LOG('mic button not found (Meet UI not loaded yet?)'); return; }
    const muted = platform.isMuted(btn);
    if (action === 'mute') {
      if (!muted) { btn.click(); weMuted = true; LOG('mic mute clicked'); }
      checkMicAfter('muted');
    } else if (action === 'unmute') {
      if (muted && weMuted) { btn.click(); LOG('mic unmute clicked'); checkMicAfter('live'); }
      else { micWarn = false; micExpected = null; }
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
  let initBackoff = 4000;
  let settledCameraOnly = false;
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
    if (workerReady || settledCameraOnly || extDead) return;
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
          if (pill) pill.title = 'Last startup error: ' + why;
          if (why.includes('budget exhausted')) {
            // The SW refuses further rebuilds: settle into a stable,
            // usable camera-only state instead of churning.
            settledCameraOnly = true;
            setPill('SnapDust: camera only (effects unavailable)', 'err');
            window.postMessage({ __snapdust: true, type: 'ml-dead' }, location.origin);
            return;
          }
          setPill('SnapDust restarting...', 'busy');
          // Bounded exponential backoff (4s..30s cap): retries are cheap
          // (one message per interval) but never tight-loop.
          if (!initTimer) initTimer = setTimeout(() => { initTimer = null; ensureWorker(); }, initBackoff);
          initBackoff = Math.min(30000, initBackoff * 2);
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
    } else if (d.type === 'settings-state') {
      fxDur = d.dur; fxDir = d.dir;
    } else if (d.type === 'gesture-state') {
      gestureOn = !!d.on;
      renderGestureChip();
    } else if (d.type === 'fx-state') {
      if (d.state === 'dust') setPill('SnapDust: vanishing...', 'dust');
      else if (d.state === 'return') setPill('SnapDust: returning...', 'dust');
      else if (d.state === 'gone') setPill('SnapDust: dusted', 'dust');
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
    pill.title = 'SnapDust: click or press Alt+S to vanish/return. Alt+B recaptures the backdrop. Finger-snap detection is off by default - enable it with the chip below (experimental).';
    pill.addEventListener('click', () => {
      // Uncalibrated: the click starts backdrop capture. Calibrated: toggle.
      window.postMessage({ __snapdust: true, type: calibrated ? 'snapdust-toggle' : 'snapdust-calibrate' }, location.origin);
      flashPill();
    });
    document.documentElement.appendChild(pill);
    makeGestureChip();
    makeSettings();
  }
  let settingsBtn, settingsPanel;
  let fxDur = 1, fxDir = 'head';
  function makeSettings() {
    if (settingsBtn) return;
    settingsBtn = document.createElement('button');
    settingsBtn.id = 'snapdust-settings-btn';
    settingsBtn.textContent = 'effect settings';
    Object.assign(settingsBtn.style, {
      position: 'fixed', right: '14px', bottom: '20px', zIndex: 99999,
      padding: '4px 10px', borderRadius: '12px', border: 'none',
      background: '#3c4043', color: '#9aa0a6',
      font: '500 11px Roboto, Arial, sans-serif', cursor: 'pointer',
      opacity: 0.85, boxShadow: '0 1px 3px rgba(0,0,0,.4)'
    });
    settingsBtn.addEventListener('click', () => {
      if (settingsPanel) { settingsPanel.remove(); settingsPanel = null; return; }
      settingsPanel = document.createElement('div');
      settingsPanel.id = 'snapdust-settings';
      Object.assign(settingsPanel.style, {
        position: 'fixed', right: '14px', bottom: '170px', zIndex: 99999,
        background: '#202124', color: '#e8eaed', padding: '10px', borderRadius: '10px',
        font: '12px Roboto, Arial, sans-serif', width: '230px',
        boxShadow: '0 2px 10px rgba(0,0,0,.5)'
      });
      const mk = (label, id, opts, val) => {
        const row = document.createElement('div');
        row.style.margin = '4px 0';
        const l = document.createElement('label');
        l.textContent = label + ' ';
        const sel = document.createElement('select');
        sel.id = id;
        for (const [v, t] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); }
        sel.value = String(val);
        sel.addEventListener('change', () => {
          const dur = document.getElementById('snapdust-dur').value;
          const dir = document.getElementById('snapdust-dir').value;
          window.postMessage({ __snapdust: true, type: 'snapdust-settings', dur: Number(dur), dir }, location.origin);
        });
        l.appendChild(sel); row.appendChild(l); return row;
      };
      settingsPanel.appendChild(mk('Speed', 'snapdust-dur', [['0.6', 'fast'], ['1', 'normal'], ['2', 'slow']], fxDur));
      settingsPanel.appendChild(mk('Style', 'snapdust-dir', [['head', 'dust, head first'], ['ltr', 'dust, left to right'], ['fade', 'fade only (no particles)']], fxDir));
      document.documentElement.appendChild(settingsPanel);
    });
    document.documentElement.appendChild(settingsBtn);
  }
  let gChip;
  let gestureOn = false;
  function makeGestureChip() {
    if (gChip) return;
    gChip = document.createElement('button');
    gChip.id = 'snapdust-gesture-chip';
    Object.assign(gChip.style, {
      position: 'fixed', right: '14px', bottom: '52px', zIndex: 99999,
      padding: '4px 10px', borderRadius: '12px', border: 'none',
      background: '#3c4043', color: '#9aa0a6',
      font: '500 11px Roboto, Arial, sans-serif', cursor: 'pointer',
      opacity: 0.85, boxShadow: '0 1px 3px rgba(0,0,0,.4)'
    });
    renderGestureChip();
    gChip.addEventListener('click', () => {
      window.postMessage({ __snapdust: true, type: 'snapdust-gesture', on: !gestureOn }, location.origin);
    });
    document.documentElement.appendChild(gChip);
  }
  function renderGestureChip() {
    if (!gChip) return;
    gChip.textContent = gestureOn ? 'auto snap: ON (experimental)' : 'auto snap: off';
    gChip.style.background = gestureOn ? '#5f3dc4' : '#3c4043';
    gChip.style.color = gestureOn ? '#fff' : '#9aa0a6';
    gChip.title = gestureOn
      ? 'Automatic finger-snap detection is ON (experimental - fast hand gestures can trigger it). Click for manual-only mode (pill or Alt+S).'
      : 'Manual mode: effects only via this pill or Alt+S. Click to enable experimental automatic finger-snap detection.';
  }
  function hidePreview() {
    if (previewDiv) { previewDiv.remove(); previewDiv = null; }
  }
  function showPreview(dataUrl, forced) {
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
    label.textContent = forced ? 'FORCED capture: no empty-frame check passed. If you or objects are visible here, press Alt+B to recapture.' : 'Backdrop captured. This is what others see while you are dusted.';
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
      if (d.preview) showPreview(d.preview, d.forced);
    } else if (d.state === 'failed') {
      calBusy = false;
      calibrated = false;
      const why = d.reason === 'person' ? 'Still sees ' + Math.round((d.coverage || 0) * 100) + '% of frame as person - Alt+Shift+B forces capture (may include you)'
        : d.reason === 'no-mask' ? 'Still starting up - click to retry'
        : d.reason === 'ml-down' ? 'Effects unavailable - camera only'
        : 'Capture failed - click to retry';
      // Sticky: the reason stays visible until the user acts. A 3s auto-hide
      // made failures look like nothing happened.
      setPill('SnapDust: ' + why, 'err');
    }
  }
  let pillBase = '', pillCls = '';
  function micSuffix() {
    const st = micState();
    if (micWarn && st === micExpected) micWarn = false;
    if (micWarn) return ' | mic: ' + (st === 'unknown' ? 'unknown, check Meet' : st.toUpperCase() + ' - check Meet');
    return ' | mic: ' + (st === 'unknown' ? 'unknown' : st);
  }
  function renderPill() {
    if (!pill) return;
    const showMic = pillCls === 'on' || pillCls === 'dust';
    pill.textContent = pillBase + (showMic ? micSuffix() : '');
    if (showMic && micWarn) pill.style.background = '#d93025';
    else pill.style.background =
      pillCls === 'on' ? '#1e8e3e' : pillCls === 'dust' ? '#7b1fa2' :
      pillCls === 'err' ? '#d93025' : pillCls === 'busy' ? '#e37400' : '#3c4043';
  }
  setInterval(renderPill, 1000);
  function setPill(text, cls) {
    if (!pill) makePill();
    pillBase = text; pillCls = cls || '';
    renderPill();
  }
  function flashPill() {
    if (!pill) return;
    pill.style.transform = 'scale(1.15)';
    setTimeout(() => { pill.style.transform = ''; }, 160);
  }
  makePill();
  setPill('SnapDust: set backdrop', '');
  window.postMessage({ __snapdust: true, type: 'snapdust-sync' }, location.origin);
  window.addEventListener('keydown', (e) => {
    if (e.altKey && e.code === 'KeyS') {
      e.preventDefault();
      window.postMessage({ __snapdust: true, type: calibrated ? 'snapdust-toggle' : 'snapdust-calibrate' }, location.origin);
      flashPill();
    } else if (e.altKey && e.shiftKey && e.code === 'KeyB') {
      e.preventDefault();
      window.postMessage({ __snapdust: true, type: 'snapdust-calibrate', force: true }, location.origin);
    } else if (e.altKey && e.code === 'KeyB') {
      e.preventDefault();
      window.postMessage({ __snapdust: true, type: 'snapdust-calibrate' }, location.origin);
      flashPill();
    }
  }, true);
})();
