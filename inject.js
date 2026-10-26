/* SnapDust - MAIN-world interceptor + effect engine.
   Wraps Meet's getUserMedia so the outgoing video track comes from a canvas
   we paint: blurred background + sharp person (segmentation) + Thanos-style
   dust disintegration. All ML runs locally in the extension worker. */
(() => {
  if (window.__snapdustMain) return;
  window.__snapdustMain = true;
  const LOG = (...a) => console.log('[SnapDust]', ...a);
  const post = (msg, transfer) =>
    window.postMessage(Object.assign({ __snapdust: true }, msg), location.origin, transfer || []);
  const postFx = (state) => post({ type: 'fx-state', state });

  /* ---------------- snap gesture detector ----------------
     A finger snap = thumb tip (4) and middle tip (12) touch, then separate
     fast. Index finger must be extended (filters out opening a fist). */
  class SnapDetector {
    constructor(onSnap) {
      this.onSnap = onSnap;
      this.phase = 'arm';
      this.pinchFirst = 0;
      this.pinchLast = 0;
      this.lastFire = 0;
    }
    feed(hands, now) {
      if (!hands || !hands.points || hands.points.length < 21) {
        this.phase = 'arm';
        return;
      }
      const p = hands.points;
      const d = (a, b) => Math.hypot(p[a][0] - p[b][0], p[a][1] - p[b][1]);
      const scale = d(0, 9) + 1e-6;
      const r = d(4, 12) / scale;
      const indexExtended = d(8, 0) / (d(5, 0) + 1e-6) > 1.35;
      const LOW = 0.30, HIGH = 0.62;
      if (this.phase === 'arm') {
        if (r < LOW && indexExtended) {
          this.phase = 'pinched';
          this.pinchFirst = now; this.pinchLast = now;
          this.wristAtPinch = [p[0][0], p[0][1]];
        }
      } else {
        if (r < LOW) {
          this.pinchLast = now;
        } else if (r > HIGH) {
          // A real snap: brief contact (touch-and-go, not a held pinch),
          // hand roughly stationary, quick release. Sign-language pinches
          // and gesticulation hold longer and travel - observed to
          // false-trigger on signing footage before these gates.
          const brief = now - this.pinchFirst <= 400;
          const still = Math.hypot(p[0][0] - this.wristAtPinch[0], p[0][1] - this.wristAtPinch[1]) < 0.10;
          if (now - this.pinchLast < 280 && brief && still && now - this.lastFire > 3000) {
            this.lastFire = now;
            this.phase = 'arm';
            this.onSnap([(p[4][0] + p[12][0]) / 2, (p[4][1] + p[12][1]) / 2]);
            return;
          }
          this.phase = 'arm';
        }
        if (now - this.pinchFirst > 1600) this.phase = 'arm';
      }
    }
  }

  /* ---------------- pipeline ---------------- */
  class Pipeline {
    constructor() {
      this.out = document.createElement('canvas');
      this.octx = this.out.getContext('2d');
      this.person = document.createElement('canvas');
      this.pctx = this.person.getContext('2d', { willReadFrequently: true });
      this.remain = document.createElement('canvas');
      this.rctx = this.remain.getContext('2d');
      this.video = document.createElement('video');
      this.video.muted = true;
      this.video.playsInline = true;
      this.maskBitmap = null;
      this.state = 'ready';          // ready | dissolving | gone | reassembling
      this.cells = null;
      this.cellSize = 8;
      // Effect settings (persisted in page localStorage like the gesture flag).
      this.fxDur = 1;            // speed multiplier on effect length
      this.fxDir = 'head';       // head | ltr | fade
      try {
        const sd = parseFloat(localStorage.getItem('__sd_dur'));
        if (sd >= 0.5 && sd <= 3) this.fxDur = sd;
        const sr = localStorage.getItem('__sd_dir');
        if (sr === 'head' || sr === 'ltr' || sr === 'fade') this.fxDir = sr;
      } catch (e) {}
      this.particles = [];
      this.flash = null;
      this.t0 = 0;
      this.busy = false;
      this.frameNo = 0;
      this.lastSend = 0;
      this.track = null;
      // Reconstructed clean background plate: updated from live frames only
      // where the mask says background, so the person region keeps its last
      // known backdrop. Used as the base layer so a dusted user is truly
      // absent (never a blurred ghost).
      this.plate = document.createElement('canvas');
      this.plateCtx = this.plate.getContext('2d');
      this.plateTmp = document.createElement('canvas');
      this.plateTmpCtx = this.plateTmp.getContext('2d');
      this.invMask = document.createElement('canvas');
      this.invMaskCtx = this.invMask.getContext('2d');
      this.plateBlur = document.createElement('canvas');
      this.plateBlurCtx = this.plateBlur.getContext('2d');
      this.plateReady = false;
      // Disappear is gated on a one-time clean backdrop capture: the camera
      // cannot see what is behind the user, so a truly empty frame must be
      // captured (user steps out) before dusting is enabled.
      this.calibrated = false;
      this.calBusy = false;
      this.disabled = false;     // fail-open: wrapper gave up, camera passes through
      this.rawMode = false;      // ML dead mid-session: canvas mirrors raw video only
      this.lastResultAt = 0;
      this.covCanvas = null;
      this.canvasTrack = null;
      this.trackMuted = false;
      this.running = false;
      this.pLast = 0;
      this.snapper = new SnapDetector((pos) => this.onSnap(pos));
    }

    // Fail-open health check: only hand Meet the canvas stream once the
    // camera actually paints through our pipeline. On any startup failure
    // the caller returns the ORIGINAL stream, so the camera can never be
    // broken by the effect path.
    async wrapChecked(stream) {
      const track = stream.getVideoTracks()[0];
      this.attachTrack(track);
      try { await this.video.play(); } catch (e) {}
      const played = await new Promise((res) => {
        const t0 = performance.now();
        const iv = setInterval(() => {
          if (this.video.readyState >= 2 && this.video.currentTime > 0.05) { clearInterval(iv); res(true); }
          else if (performance.now() - t0 > 4000) { clearInterval(iv); res(false); }
        }, 100);
      });
      if (!played) { this.teardown('video did not start within 4s'); return false; }
      try {
        this.draw();
      } catch (e) { this.teardown('first draw failed: ' + e); return false; }
      return true;
    }

    teardown(why) {
      this.disabled = true;
      try { this.video.srcObject = null; } catch (e) {}
      if (this.canvasTrack) { try { this.canvasTrack.stop(); } catch (e) {} this.canvasTrack = null; }
      LOG('pipeline disabled (' + why + '); camera passes through untouched');
    }

    wrap(stream) {
      const out = new MediaStream();
      out.addTrack(this.canvasTrack);
      for (const t of stream.getAudioTracks()) out.addTrack(t);
      return out;
    }

    attachTrack(track) {
      if (this.track === track) return;
      this.track = track;
      track.addEventListener('mute', () => { this.trackMuted = true; });
      track.addEventListener('unmute', () => { this.trackMuted = false; });
      track.addEventListener('ended', () => {
        if (this.track === track) {
          this.track = null;
          // Drop the canvas track too: a fresh getUserMedia call re-creates
          // both, and Meet must never be handed an ended track.
          if (this.canvasTrack) { try { this.canvasTrack.stop(); } catch (e) {} this.canvasTrack = null; }
        }
      });
      const s = track.getSettings();
      let w = Math.min(1280, s.width || 1280);
      let h = s.height ? Math.round(w * s.height / s.width) : Math.round(w * 9 / 16);
      if (this.out.width !== w || this.out.height !== h) {
        for (const c of [this.out, this.person, this.remain]) { c.width = w; c.height = h; }
        this.cellSize = Math.max(6, Math.round(w / 200));
      }
      this.video.srcObject = new MediaStream([track]);
      this.video.play().catch(() => {});
      if (!this.canvasTrack || this.canvasTrack.readyState === 'ended') {
        this.canvasTrack = this.out.captureStream(30).getVideoTracks()[0];
        this.startLoop();
      }
      post({ type: 'hello' });
      postFx('ready');
      LOG('camera stream wrapped', w + 'x' + h);
    }

    startLoop() {
      if (this.running) return;
      this.running = true;
      const loop = () => {
        if (this.disabled) return;
        try {
          this.draw(); this.maybeSend(performance.now());
          // Watchdog: ML results stopped arriving mid-session (wedged
          // worker, dead offscreen) - keep the camera, drop the effects.
          if (!this.rawMode && this.lastResultAt && performance.now() - this.lastResultAt > 12000) {
            this.rawMode = true;
            postFx('raw');
            LOG('ML results stalled; camera-only passthrough engaged');
          }
        }
        catch (e) { LOG('loop error', e); }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }

    updatePlate() {
      const w = this.out.width, h = this.out.height;
      if (!w || this.video.readyState < 2 || !this.maskBitmap) return;
      if (this.plate.width !== w) {
        this.plate.width = this.plateTmp.width = this.invMask.width = w;
        this.plate.height = this.plateTmp.height = this.invMask.height = h;
      }
      // invMask: opaque where background
      const im = this.invMaskCtx;
      im.globalCompositeOperation = 'source-over';
      im.clearRect(0, 0, w, h);
      im.fillStyle = '#fff';
      im.fillRect(0, 0, w, h);
      im.globalCompositeOperation = 'destination-out';
      // Generously dilate the person region so person-edge halo, mask
      // latency and near-person pixels the segmenter misses (hair, hands,
      // held objects) never get baked into the retained background.
      const dx = w * 0.14, dy = h * 0.14;
      im.drawImage(this.maskBitmap, -dx / 2, -dy / 2, w + dx, h + dy);
      // tmp = (live frame where background) over (old plate where person)
      const t = this.plateTmpCtx;
      t.globalCompositeOperation = 'source-over';
      t.clearRect(0, 0, w, h);
      t.drawImage(this.video, 0, 0, w, h);
      t.globalCompositeOperation = 'destination-in';
      t.drawImage(this.invMask, 0, 0);
      t.globalCompositeOperation = 'destination-over';
      if (this.plateReady) t.drawImage(this.plate, 0, 0);
      t.globalCompositeOperation = 'source-over';
      this.plateCtx.clearRect(0, 0, w, h);
      this.plateCtx.drawImage(this.plateTmp, 0, 0);
      this.plateReady = true;
      // Edge-diffusion fill: blur the plate and pull the result INTO the
      // still-unknown (transparent) person region only. Person pixels never
      // enter the plate, so the hidden area converges to surrounding
      // background tones within about a second of updates.
      if (this.plateBlur.width !== w) { this.plateBlur.width = w; this.plateBlur.height = h; }
      // 1) Fill never-seen (transparent) areas by pulling blurred plate
      //    content into them.
      for (let pass = 0; pass < 4; pass++) {
        const b = this.plateBlurCtx;
        b.globalCompositeOperation = 'source-over';
        b.clearRect(0, 0, w, h);
        b.filter = 'blur(12px)';
        b.drawImage(this.plate, 0, 0);
        b.filter = 'none';
        this.plateCtx.globalCompositeOperation = 'destination-over';
        this.plateCtx.drawImage(this.plateBlur, 0, 0);
        this.plateCtx.globalCompositeOperation = 'source-over';
      }
      // The person region is never touched: the plate started as a
      // verified-empty backdrop capture, and only true background pixels
      // (per the dilated inverse mask) refresh it afterward.
    }

    renderPersonCutout() {
      const w = this.out.width, h = this.out.height;
      const p = this.pctx;
      p.save();
      p.globalCompositeOperation = 'source-over';
      p.clearRect(0, 0, w, h);
      p.drawImage(this.video, 0, 0, w, h);
      p.globalCompositeOperation = 'destination-in';
      // Feather the low-res segmentation mask so the cutout edge blends into
      // the backdrop instead of showing hard pixel steps.
      p.filter = 'blur(3px)';
      p.drawImage(this.maskBitmap, 0, 0, w, h);
      p.filter = 'none';
      p.restore();
    }

    draw() {
      const w = this.out.width, h = this.out.height;
      if (!w || this.video.readyState < 2) return;
      const o = this.octx;
      if (this.trackMuted) { o.fillStyle = '#000'; o.fillRect(0, 0, w, h); return; }
      o.clearRect(0, 0, w, h);
      // Raw passthrough: ML is dead or the extension context died. The user
      // keeps a working camera with zero effects rather than a black screen.
      if (this.rawMode) { o.drawImage(this.video, 0, 0, w, h); return; }
      // base layer: reconstructed clean background (no person). Before the
      // first plate exists, fall back to a heavily blurred live frame.
      o.save();
      if (this.plateReady) {
        o.fillStyle = '#202124';
        o.fillRect(0, 0, w, h);
        o.filter = 'blur(2px)';
        o.drawImage(this.plate, -w * 0.02, -h * 0.02, w * 1.04, h * 1.04);
      } else {
        o.filter = 'blur(18px) brightness(0.98)';
        o.drawImage(this.video, -w * 0.04, -h * 0.04, w * 1.08, h * 1.08);
      }
      o.restore();
      if (this.state === 'ready') {
        // Normal viewing is a pure camera passthrough. Compositing the
        // person cutout over the frozen plate here caused constant visible
        // glitches: any live motion (sway, hand moves) misaligns with the
        // frozen plate and shows as double-image edges and pixel blocks.
        // The composite is only needed while the effect is active.
        o.drawImage(this.video, 0, 0, w, h);
      } else if (this.state === 'dissolving' || this.state === 'reassembling') {
        if (this.fxDir === 'fade') {
          const st = this.state;
          const k = this.stepFade();
          o.save();
          o.globalAlpha = st === 'dissolving' ? 1 - k : k;
          o.drawImage(this.person, 0, 0);
          o.restore();
        } else {
          this.stepCells();
          o.drawImage(this.remain, 0, 0);
        }
      }
      // state 'gone': clean background plate only - the person is absent.
      if (window.__sdDebugMask && this.maskBitmap) {
        o.save();
        o.globalAlpha = 0.85;
        o.drawImage(this.maskBitmap, 12, 12, 320, 180);
        o.restore();
      }
      this.drawParticles(o);
      this.drawFlash(o);
    }

    // Fade-only mode: no particles. Returns progress 0..1 and ends the
    // state when done. (draw() maps progress to alpha per direction.)
    stepFade() {
      const k = Math.min(1, (performance.now() - this.t0) / 1000 / (1.2 * this.fxDur));
      if (k >= 1) {
        if (this.state === 'dissolving') { this.state = 'gone'; postFx('gone'); }
        else { this.state = 'ready'; postFx('ready'); }
        return 1;
      }
      return k;
    }

    buildCells(reverse) {
      if (this.fxDir === 'fade') { this.renderPersonCutout(); this.cells = []; return; }
      const w = this.out.width, h = this.out.height, cs = this.cellSize;
      this.renderPersonCutout();
      const img = this.pctx.getImageData(0, 0, w, h).data;
      this.rctx.clearRect(0, 0, w, h);
      if (reverse) {
        // reassemble: start empty, cells get stamped back from the cutout
      } else {
        this.rctx.drawImage(this.person, 0, 0);
      }
      const cols = Math.ceil(w / cs), rows = Math.ceil(h / cs);
      const cells = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = Math.min(w - 1, c * cs + (cs >> 1));
          const y = Math.min(h - 1, r * cs + (cs >> 1));
          const i = (y * w + x) * 4;
          if (img[i + 3] > 40) {
            // Reference-informed sweep: top-to-bottom (head first) for both
            // dissolve and reassemble - the face goes first and returns
            // first, which reads as the Thanos-style effect the user
            // pointed at. (Was a left/right sweep.)
            const sweep = this.fxDir === 'ltr' ? c / cols : r / rows;
            cells.push({
              x: c * cs, y: r * cs, done: false,
              delay: (sweep * 0.7 + Math.random() * 0.45) * this.fxDur,
              color: `rgb(${img[i]},${img[i + 1]},${img[i + 2]})`
            });
          }
        }
      }
      this.cells = cells;
      LOG('cells:', cells.length);
    }

    stepCells() {
      if (!this.cells) return;
      const t = (performance.now() - this.t0) / 1000;
      const cs = this.cellSize;
      if (this.state === 'dissolving') {
        const r = this.rctx;
        r.save();
        r.globalCompositeOperation = 'destination-out';
        r.fillStyle = '#000';
        for (const c of this.cells) {
          if (!c.done && t > c.delay) {
            c.done = true;
            r.fillRect(c.x, c.y, cs, cs);
            this.spawnCellParticles(c, 2);
          }
        }
        r.restore();
        if (t > 1.5 * this.fxDur) {
          this.state = 'gone';
          this.cells = null;
          this.rctx.clearRect(0, 0, this.out.width, this.out.height);
          postFx('gone');
        }
      } else if (this.state === 'reassembling') {
        const r = this.rctx;
        for (const c of this.cells) {
          if (!c.done && t > c.delay) {
            c.done = true;
            r.drawImage(this.person, c.x, c.y, cs, cs, c.x, c.y, cs, cs);
            this.spawnCellParticles(c, 1);
          }
        }
        if (t > 1.4 * this.fxDur) {
          this.state = 'ready';
          this.cells = null;
          postFx('ready');
        }
      }
    }

    spawnCellParticles(c, n) {
      if (this.particles.length > 30000) return;
      const cs = this.cellSize;
      for (let i = 0; i < n; i++) {
        this.particles.push({
          x: c.x + Math.random() * cs,
          y: c.y + Math.random() * cs,
          vx: 60 + Math.random() * 160,
          vy: -(30 + Math.random() * 150),
          size: 1.5 + Math.random() * 3,
          life: 0,
          ttl: 0.7 + Math.random() * 0.9,
          seed: Math.random() * 10,
          color: c.color
        });
      }
    }

    drawParticles(o) {
      if (!this.particles.length) { this.pLast = 0; return; }
      const now = performance.now();
      const dt = Math.min(0.05, this.pLast ? (now - this.pLast) / 1000 : 0.016);
      this.pLast = now;
      const alive = [];
      for (const p of this.particles) {
        p.life += dt;
        if (p.life >= p.ttl) continue;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy -= 40 * dt;                    // dust rises
        p.vx *= (1 - 0.5 * dt);
        p.x += Math.sin(p.life * 7 + p.seed) * 0.7;
        const a = Math.max(0, 1 - p.life / p.ttl);
        o.globalAlpha = a * 0.9;
        o.fillStyle = p.color;
        const s = p.size * (1 - 0.5 * p.life / p.ttl);
        o.fillRect(p.x, p.y, s, s);
        alive.push(p);
      }
      this.particles = alive;
      o.globalAlpha = 1;
    }

    drawFlash(o) {
      if (!this.flash) return;
      const t = (performance.now() - this.flash.t0) / 1000;
      if (t > 0.45) { this.flash = null; return; }
      const k = t / 0.45;
      o.save();
      o.globalAlpha = (1 - k) * 0.8;
      o.strokeStyle = '#fff';
      o.lineWidth = 3;
      o.beginPath();
      o.arc(this.flash.x, this.flash.y, 12 + k * 90, 0, Math.PI * 2);
      o.stroke();
      o.restore();
    }

    // Fraction of the frame covered by the person mask (0..1), or null
    // when no segmentation mask has arrived yet.
    personCoverage() {
      if (!this.maskBitmap) return null;
      if (!this.covCanvas) {
        this.covCanvas = document.createElement('canvas');
        this.covCanvas.width = 64; this.covCanvas.height = 36;
        this.covCtx = this.covCanvas.getContext('2d', { willReadFrequently: true });
      }
      const x = this.covCtx;
      x.clearRect(0, 0, 64, 36);
      x.drawImage(this.maskBitmap, 0, 0, 64, 36);
      const d = x.getImageData(0, 0, 64, 36).data;
      let s = 0;
      for (let i = 3; i < d.length; i += 4) s += d[i];
      return s / (64 * 36 * 255);
    }

    // Countdown-driven backdrop capture: the user clicks, steps out of the
    // frame during the countdown, and we grab a verified-empty frame.
    startCalibration(force) {
      if (this.calBusy) return;
      this.forceCal = !!force;
      if (this.rawMode) {
        post({ type: 'cal-state', state: 'failed', reason: 'ml-down' });
        LOG('calibration refused: effects engine is down (camera-only mode)');
        return;
      }
      if (this.state !== 'ready') {
        post({ type: 'cal-state', state: 'failed', reason: 'busy' });
        return;
      }
      this.calBusy = true;
      let n = 4;
      post({ type: 'cal-state', state: 'countdown', n });
      const iv = setInterval(() => {
        n--;
        if (n > 0) {
          post({ type: 'cal-state', state: 'countdown', n });
        } else {
          clearInterval(iv);
          this.captureBackdrop();
        }
      }, 1000);
    }

    // Capture is bound to the camera INPUT time, not to when a result
    // arrives: snapshot the video, then judge only a mask whose input frame
    // was sent at or after that snapshot (result ts echoes the send time).
    // A mask whose inference started before the countdown ended, or before
    // the snapshot, is ignored, so a stale frame can't veto or approve.
    captureBackdrop() {
      const w = this.out.width, h = this.out.height;
      if (!w || this.video.readyState < 2) {
        this.calBusy = false;
        post({ type: 'cal-state', state: 'failed', reason: 'no-video' });
        return;
      }
      this.calWaiting = true;
      this.calBest = null;
      this.calTries = 0;
      this.calDeadline = performance.now() + 8000;
      post({ type: 'cal-state', state: 'verifying' });
      this.takeCandidate();
      clearTimeout(this.calTimer);
      this.calTimer = setTimeout(() => {
        if (!this.calWaiting) return;
        this.calWaiting = false;
        this.calBusy = false;
        if (this.calBest == null) {
          post({ type: 'cal-state', state: 'failed', reason: 'no-mask' });
        } else {
          post({ type: 'cal-state', state: 'failed', reason: 'person', coverage: this.calBest });
          LOG('backdrop rejected: lowest person coverage across', this.calTries, 'fresh frames', this.calBest.toFixed(3));
        }
      }, 8000);
    }

    takeCandidate() {
      const w = this.out.width, h = this.out.height;
      if (!this.cand) this.cand = document.createElement('canvas');
      this.cand.width = w; this.cand.height = h;
      this.cand.getContext('2d').drawImage(this.video, 0, 0, w, h);
      this.candT = performance.now();
    }

    onCalMask(inputTs) {
      if (!this.calWaiting) return;
      if (typeof inputTs !== 'number' || inputTs < this.candT) return; // stale input
      const cov = this.personCoverage();
      if (cov == null) return;
      this.calTries++;
      if (this.calBest == null || cov < this.calBest) this.calBest = cov;
      if (cov > 0.04 && !this.forceCal) {
        // Person (or something mask-detected) in this frame: take a newer
        // snapshot and judge the next fresh result.
        this.takeCandidate();
        return;
      }
      this.calWaiting = false;
      clearTimeout(this.calTimer);
      this.commitPlate(cov, cov > 0.04);
    }

    commitPlate(cov, forced) {
      const w = this.out.width, h = this.out.height;
      if (this.plate.width !== w) {
        this.plate.width = this.plateTmp.width = this.invMask.width = w;
        this.plate.height = this.plateTmp.height = this.invMask.height = h;
      }
      this.plateCtx.globalCompositeOperation = 'source-over';
      this.plateCtx.clearRect(0, 0, w, h);
      this.plateCtx.drawImage(this.cand, 0, 0, w, h);
      this.plateReady = true;
      this.calibrated = true;
      this.calBusy = false;
      const pv = document.createElement('canvas');
      pv.width = 320; pv.height = Math.max(2, Math.round(320 * h / w));
      pv.getContext('2d').drawImage(this.plate, 0, 0, pv.width, pv.height);
      post({ type: 'cal-state', state: 'captured', preview: pv.toDataURL('image/jpeg', 0.75), coverage: cov, forced: !!forced });
      LOG('backdrop captured (person coverage', cov.toFixed(3) + (forced ? ', FORCED without empty check' : '') + ')');
    }

    onSnap(pos) {
      if (!this.calibrated) {
        post({ type: 'cal-state', state: 'needed' });
        LOG('snap ignored: no backdrop captured yet');
        return;
      }
      if (this.state === 'ready') {
        if (!this.maskBitmap) { LOG('snap ignored: no segmentation mask yet'); return; }
        this.buildCells(false);
        this.state = 'dissolving';
        this.t0 = performance.now();
        if (pos) this.flash = { x: pos[0] * this.out.width, y: pos[1] * this.out.height, t0: performance.now() };
        post({ type: 'mic', action: 'mute' });
        postFx('dust');
        LOG('snap! disintegrating');
      } else if (this.state === 'gone') {
        if (!this.maskBitmap) { LOG('snap ignored: no segmentation mask yet'); return; }
        this.buildCells(true);
        this.state = 'reassembling';
        this.t0 = performance.now();
        if (pos) this.flash = { x: pos[0] * this.out.width, y: pos[1] * this.out.height, t0: performance.now() };
        post({ type: 'mic', action: 'unmute' });
        LOG('snap! reassembling');
      }
    }

    manualToggle() { this.onSnap(null); }

    maybeSend(now) {
      if (this.disabled) return;
      // In raw passthrough keep a 0.5 fps probe trickle so ML recovery is
      // detected and effects re-enable themselves.
      if (this.rawMode && now - this.lastSend < 2000) return;
      if (!this.rawMode && now - this.lastSend < 50) return;
      // Frames can be dropped in transit (worker not ready yet, world hop).
      // Without a result the busy flag would otherwise stick forever, so
      // retry once a second regardless.
      if (this.busy && now - this.lastSend < 1000) return;
      if (this.video.readyState < 2) return;
      this.busy = true;
      this.lastSend = now;
      this.frameNo++;
      const wantMask = this.state !== 'gone' || this.frameNo % 3 === 0;
      const vw = this.video.videoWidth, vh = this.video.videoHeight;
      const sw = 640, sh = Math.max(2, Math.round(640 * vh / vw));
      // MAIN-world -> isolated-world postMessage strips ImageBitmaps
      // (transferred or cloned); only plain data survives. Ship raw pixels.
      try {
        if (!this.sendCanvas) {
          this.sendCanvas = document.createElement('canvas');
          this.sendCtx = this.sendCanvas.getContext('2d', { willReadFrequently: true });
        }
        this.sendCanvas.width = sw; this.sendCanvas.height = sh;
        this.sendCtx.drawImage(this.video, 0, 0, sw, sh);
        const img = this.sendCtx.getImageData(0, 0, sw, sh);
        post({ type: 'frame', id: this.frameNo, ts: now, wantHands: true, wantMask, w: sw, h: sh, pixels: img.data });
      } catch (e) { this.busy = false; LOG('frame grab failed', String(e)); }
    }
  }

  const pipeline = new Pipeline();
  // Gesture detection defaults OFF (manual mode). The user opts into
  // experimental auto-snap via the pill chip; the choice persists.
  pipeline.gestureEnabled = false;
  try { pipeline.gestureEnabled = localStorage.getItem('__sd_gesture') === '1'; } catch (e) {}
  post({ type: 'gesture-state', on: pipeline.gestureEnabled });
  post({ type: 'settings-state', dur: pipeline.fxDur, dir: pipeline.fxDir });

  /* ---------------- messages from the isolated content script ---------------- */
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || d.__snapdust !== true) return;
    if (d.type === 'ml-result') {
      pipeline.busy = false;
      if (d.mask || d.hands) pipeline.lastResultAt = performance.now();
      if (pipeline.gestureEnabled) pipeline.snapper.feed(d.hands, performance.now());
      if (d.mask && !pipeline.testMode) {
        if (pipeline.maskBitmap && pipeline.maskBitmap.close) pipeline.maskBitmap.close();
        pipeline.maskBitmap = d.mask;
        if (typeof d.coverage === 'number') pipeline.lastCoverage = d.coverage;
        pipeline.onCalMask(d.ts);
        // The backdrop plate is frozen once captured: live background
        // refresh can bake missed-detection pixels (hair, hands, held
        // objects) into the plate as the user moves. Lighting changes are
        // handled by recapture (Alt+B), not by risky incremental updates.
        if (!pipeline.calibrated) pipeline.updatePlate();
      }
    } else if (d.type === 'ml-dead' || d.type === 'ext-dead') {
      if (!pipeline.rawMode) {
        pipeline.rawMode = true;
        postFx('raw');
        LOG(d.type + ': camera-only passthrough engaged');
      }
    } else if (d.type === 'ml-alive') {
      if (pipeline.rawMode) { pipeline.rawMode = false; postFx('ready'); LOG('ML back; effects re-enabled'); }
    } else if (d.type === 'snapdust-gesture') {
      pipeline.gestureEnabled = !!d.on;
      try { localStorage.setItem('__sd_gesture', d.on ? '1' : '0'); } catch (e) {}
      LOG('gesture detection: ' + (pipeline.gestureEnabled ? 'ON (experimental)' : 'off (manual mode)'));
      post({ type: 'gesture-state', on: pipeline.gestureEnabled });
    } else if (d.type === 'snapdust-settings') {
      const dur = Number(d.dur), dir = d.dir;
      if (dur >= 0.5 && dur <= 3) pipeline.fxDur = dur;
      if (dir === 'head' || dir === 'ltr' || dir === 'fade') pipeline.fxDir = dir;
      try { localStorage.setItem('__sd_dur', String(pipeline.fxDur)); localStorage.setItem('__sd_dir', pipeline.fxDir); } catch (e) {}
      post({ type: 'settings-state', dur: pipeline.fxDur, dir: pipeline.fxDir });
    } else if (d.type === 'snapdust-toggle') {
      pipeline.manualToggle();
    } else if (d.type === 'snapdust-calibrate') {
      pipeline.startCalibration(!!d.force);
    } else if (d.type === 'test-mask') {
      // test hook used by the offline FX harness only
      pipeline.testMode = true;
      if (pipeline.maskBitmap && pipeline.maskBitmap.close) pipeline.maskBitmap.close();
      pipeline.maskBitmap = d.bitmap;
    }
  });

  /* ---------------- wrap getUserMedia before Meet loads ---------------- */
  const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = function (constraints) {
    return origGetUserMedia(constraints).then(async (stream) => {
      try {
        if (pipeline.disabled) return stream;
        if (constraints && constraints.video && stream.getVideoTracks().length) {
          const ok = await pipeline.wrapChecked(stream);
          if (ok) return pipeline.wrap(stream);
        }
      } catch (e) { LOG('wrap failed, passing camera through untouched', e); }
      // Fail open: Meet gets the camera exactly as if SnapDust were absent.
      return stream;
    });
  };
  LOG('armed: getUserMedia wrapped');
})();
