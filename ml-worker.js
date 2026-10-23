/* SnapDust ML worker: hand landmarks + person segmentation. Everything runs
   locally inside this extension worker; no video ever leaves the machine.

   Robustness rules (learned from a field failure):
   - Timestamps fed to MediaPipe VIDEO-mode graphs must be strictly
     increasing per graph. The page clock (performance.now) resets on every
     reload while this worker persists in the offscreen document, so the
     page clock is never trusted: a worker-owned monotonic clock is used.
   - The GPU delegate is only used after a WebGL2 preflight succeeds; on
     machines where offscreen WebGL is broken the CPU (XNNPACK) delegate is
     used instead, avoiding a fatal wasm abort that can crash the shared
     GPU process and black out the camera browser-wide.
   - Inference errors are counted; after a streak the worker declares
     itself dead so the offscreen document can be recreated cleanly. */
let vision = null, handLandmarker = null, segmenter = null;
let delegate = null;
let errStreak = 0, dead = false;
let tsLast = 0;
const log = (...a) => self.postMessage({ type: 'log', args: a });

// Worker-owned monotonic microsecond clock. Never decreases, even if the
// page reloads and its own clock restarts.
function nextTs() {
  const t = Math.max(tsLast + 1, Math.floor(performance.now() * 1000));
  tsLast = t;
  return t;
}

function webgl2Available() {
  try {
    const c = new OffscreenCanvas(8, 8);
    const gl = c.getContext('webgl2');
    return !!gl;
  } catch (e) { return false; }
}

async function createModels(useDelegate) {
  handLandmarker = await self.Vision.HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: self.__sdHandUrl, delegate: useDelegate },
    runningMode: 'VIDEO', numHands: 1,
    minHandDetectionConfidence: 0.35, minHandPresenceConfidence: 0.35, minTrackingConfidence: 0.35
  });
  segmenter = await self.Vision.ImageSegmenter.createFromOptions(vision, {
    baseOptions: { modelAssetPath: self.__sdSegUrl, delegate: useDelegate },
    runningMode: 'VIDEO', outputCategoryMask: false, outputConfidenceMasks: true
  });
}

self.onmessage = async (ev) => {
  const d = ev.data;
  try {
    if (d.type === 'init') {
      self.__sdHandUrl = d.handUrl;
      self.__sdSegUrl = d.segUrl;
      importScripts(d.bundleUrl);
      vision = await self.Vision.FilesetResolver.forVisionTasks(d.wasmBase);
      // CPU (XNNPACK) is the DEFAULT delegate: on the field machine the GL
      // path crashed the offscreen renderer hard enough to black out the
      // camera, and a wasm CHECK abort kills the process before any error
      // can be reported, so no fallback can catch it. GPU is opt-in only,
      // behind an explicit flag, and still requires the WebGL2 preflight.
      let want = (d.forceGpu && webgl2Available()) ? 'GPU' : 'CPU';
      try {
        await createModels(want);
        delegate = want;
      } catch (e) {
        log('model init with', want, 'failed, retrying on CPU:', String(e));
        handLandmarker = null; segmenter = null;
        await createModels('CPU');
        delegate = 'CPU';
      }
      log('models ready, delegate:', delegate);
      self.postMessage({ type: 'ready', delegate });
      return;
    }
    if (d.type === 'frame') {
      if (dead || !handLandmarker) {
        if (d.bitmap && d.bitmap.close) d.bitmap.close();
        self.postMessage({ type: 'result', id: d.id, dead: true, hands: null, mask: null });
        return;
      }
      const ts = nextTs();
      const out = { type: 'result', id: d.id, ts, hands: null, mask: null };
      let frameErr = false;
      if (d.wantHands) {
        try {
          const res = handLandmarker.detectForVideo(d.bitmap, ts);
          if (res && res.landmarks && res.landmarks.length) {
            const lm = res.landmarks[0];
            const score = (res.handedness && res.handedness[0] && res.handedness[0][0] && res.handedness[0][0].score) || 0;
            out.hands = { points: lm.map(p => [p.x, p.y]), score };
          }
        } catch (e) { frameErr = true; log('hand inference error:', String(e)); }
      }
      if (d.wantMask && segmenter) {
        try {
          const res = segmenter.segmentForVideo(d.bitmap, ts);
          if (res && res.confidenceMasks && res.confidenceMasks.length) {
            // Threshold the person confidence channel instead of using the
            // hard category mask: a high cutoff drops the loose halo AND
            // low-confidence interior regions (posters, flags, objects near
            // the person) that the binary mask keeps. Channel 0 = person for
            // this model (matches the verified category-0-person mapping).
            const m = res.confidenceMasks[res.confidenceMasks.length - 1]; // last channel = person (background is first for this model)
            const w = m.width, h = m.height;
            const conf = m.getAsFloat32Array();
            const data = new Uint8Array(conf.length);
            for (let i = 0; i < conf.length; i++) data[i] = conf[i] > 0.65 ? 0 : 1;
            // Then erode 1 mask pixel (8-neighborhood) for a tight edge;
            // the feather at draw time keeps it soft.
            let cur = data;
            for (let pass = 0; pass < 1; pass++) {
              const er = new Uint8Array(cur.length).fill(1); // 1 = background
              for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                  const i = y * w + x;
                  if (cur[i] !== 0) continue; // background stays background
                  let keep = 1;
                  for (let dy = -1; dy <= 1 && keep; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                      const nx = x + dx, ny = y + dy;
                      if (nx < 0 || ny < 0 || nx >= w || ny >= h || cur[ny * w + nx] !== 0) { keep = 0; break; }
                    }
                  }
                  er[i] = keep ? 0 : 1;
                }
              }
              cur = er;
            }
            const img = new ImageData(w, h);
            const px = img.data;
            let personPx = 0;
            for (let i = 0; i < cur.length; i++) {
              const o = i * 4;
              px[o] = 255; px[o + 1] = 255; px[o + 2] = 255;
              px[o + 3] = cur[i] === 0 ? 255 : 0; // category 0 = person (verified visually); non-zero = background
              if (cur[i] === 0) personPx++;
            }
            out.coverage = personPx / cur.length;
            const oc = new OffscreenCanvas(w, h);
            oc.getContext('2d').putImageData(img, 0, 0);
            out.mask = oc.transferToImageBitmap();
            for (const cm of res.confidenceMasks) cm.close();
          }
        } catch (e) { frameErr = true; log('segmentation error:', String(e)); }
      }
      d.bitmap.close();
      if (frameErr) {
        errStreak++;
        if (errStreak >= 5 && !dead) {
          dead = true;
          log('too many consecutive inference errors; declaring ML dead');
          self.postMessage({ type: 'dead' });
        }
      } else {
        errStreak = 0;
      }
      self.postMessage(out, out.mask ? [out.mask] : []);
    }
  } catch (e) {
    log('error', String((e && e.stack) || e));
    if (d && d.bitmap && d.bitmap.close) d.bitmap.close();
  }
};
