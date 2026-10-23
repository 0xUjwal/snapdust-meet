/* SnapDust background router. Meet enforces Trusted Types, which blocks
   extension script loading in page-origin workers, so ML inference lives in
   an offscreen extension document (extension origin, extension CSP). This
   service worker creates that document on demand, health-checks it, and
   recreates it when its ML runtime dies (e.g. after a wasm abort). */
console.log('[SnapDust SW] boot');

let restarts = 0;
let restartWindowStart = 0;
async function createOffscreen(forceGpu) {
  const url = forceGpu ? 'offscreen.html?gpu=1' : 'offscreen.html';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await chrome.offscreen.createDocument({
        url,
        reasons: ['WORKERS'],
        justification: 'Runs local hand-tracking and person-segmentation models in an extension worker; Meet page policies block page-origin workers.'
      });
      return;
    } catch (e) {
      console.log('[SnapDust SW] createDocument attempt', attempt + 1, 'failed:', String(e));
      if (attempt === 0) {
        // Stale half-closed document from a crash/race: clear and retry once.
        await new Promise(r => setTimeout(r, 600));
        try { await chrome.offscreen.closeDocument(); } catch (e2) {}
      } else {
        throw e;
      }
    }
  }
}

function pingOffscreen(timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeoutMs);
    try {
      chrome.runtime.sendMessage({ sd: true, type: 'ping' }, (r) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError || !r) resolve(null);
        else resolve(r);
      });
    } catch (e) {
      if (!done) { done = true; clearTimeout(timer); resolve(null); }
    }
  });
}

async function ensureOffscreen(forceGpu) {
  const exists = await chrome.offscreen.hasDocument();
  if (exists) {
    const pong = await pingOffscreen(2000);
    if (pong && !pong.dead) {
      // A GPU request against a live CPU document must rebuild it.
      if (forceGpu && pong.delegate === 'CPU') {
        console.log('[SnapDust SW] GPU delegate requested; recreating offscreen');
        try { await chrome.offscreen.closeDocument(); } catch (e) {}
      } else {
        return { ok: true, reused: true, ready: !!pong.ready, delegate: pong.delegate || null };
      }
    } else {
      // Document missing its message loop or ML declared dead: rebuild fresh.
      console.log('[SnapDust SW] offscreen unhealthy, recreating', pong);
      try { await chrome.offscreen.closeDocument(); } catch (e) {}
    }
  }
  await createOffscreen(forceGpu);
  return { ok: true, reused: false };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.sd !== true) return false;
  if (msg.type === 'init') {
    (async () => {
      try {
        sendResponse(await ensureOffscreen(!!msg.forceGpu));
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
  if (msg.type === 'ml-dead') {
    // The offscreen document's worker gave up. Recreate it, rate-limited so
    // a persistently crashing machine does not loop forever.
    (async () => {
      const now = Date.now();
      if (now - restartWindowStart > 10 * 60 * 1000) { restarts = 0; restartWindowStart = now; }
      if (restarts >= 3) { console.log('[SnapDust SW] ML restart limit reached; staying down'); return; }
      restarts++;
      console.log('[SnapDust SW] ML declared dead; recreating offscreen document (restart', restarts + ')');
      try { await chrome.offscreen.closeDocument(); } catch (e) {}
      try { await createOffscreen(); } catch (e) { console.log('[SnapDust SW] recreate failed', String(e)); }
    })();
    return false;
  }
  return false;
});
