# SnapDust for Google Meet

Snap your fingers on camera to crumble into dust and mute your mic. Snap again to reassemble and unmute. Everything runs locally in your browser - no video ever leaves your machine.

**Status: early test build.** Install from the [latest release](../../releases) (download `snapdust-meet.zip`) or load this repo folder directly.

## Install

1. Download and unzip `snapdust-meet.zip` somewhere permanent (Chrome loads the extension from that folder - don't delete it). Or clone this repo and use its root folder.
2. Open `chrome://extensions`, enable **Developer mode** (top right).
3. Click **Load unpacked** and select the folder containing `manifest.json`.
4. Close and reopen any Meet tab.

## Use

1. Join a meeting (solo test meeting first). Look for the small **SnapDust** pill at the bottom-right.
2. **First time / new room:** click the pill or press **Alt+B** - a 4-second countdown runs while you step fully out of frame, then it captures your empty room as the backdrop and shows a preview (**Looks good** / **Recapture**). A camera cannot invent the pixels behind you, so this one-time capture is what makes the empty-room illusion real.
3. **Snap your fingers on camera** (or press **Alt+S** / click the pill) - you disintegrate and your mic mutes via Meet's own mic button, so Meet's UI stays truthful.
4. Snap again - you reassemble and the mic unmutes (only if SnapDust muted it).

Pill states: green ready / purple dusted / orange busy / red camera-only (effects paused; recovers on its own) / restarting.

## How it works

- `inject.js` (MAIN world) wraps `getUserMedia`; the outgoing video comes from a canvas compositor: frozen clean-room backdrop + live person cutout (segmentation) + a dust-particle dissolve.
- ML (MediaPipe HandLandmarker + selfie segmenter) runs in an offscreen extension document (`offscreen.js` -> `ml-worker.js`) because Meet's Trusted Types policy blocks page-origin workers. The **CPU (XNNPACK) delegate is the default** - the GPU delegate crashed hard enough on some machines to black out the camera. GPU is opt-in via `localStorage.__sd_force_gpu = '1'`.
- `content.js` (isolated world) bridges frames/results, clicks Meet's mic button, renders the pill.
- `background.js` (service worker) owns the offscreen document lifecycle: health pings, zombie detection (3 unanswered frames), crash rebuild.
- Reliability design: fail-open camera (Meet gets the original stream if the pipeline can't paint within 4s), raw camera passthrough if ML dies mid-call, monotonic worker-owned timestamps (page reloads can't break inference), per-tab frame ids.

## Honest limits

- Tested with a simulated camera in headless Chrome plus Meet-origin probes; real-camera snap tuning and in-call behavior may still need adjustment.
- CPU inference costs some smoothness vs GPU; the frozen backdrop does not adapt if you move the camera or change lighting - recapture with **Alt+B**.
- Meet first; the architecture allows Teams/Zoom adapters later (none shipped).

## Development

Tests (need `npm i puppeteer-core`, Chrome for Testing, and fake-camera y4m files that are not committed due to size):

```
cd test && python3 -m http.server 8787 &
node run.mjs real      # full calibration + dust cycle (CPU delegate)
node run.mjs reload    # page-reload inference continuity
node run.mjs killoff   # offscreen ML destruction + auto-recovery
node run.mjs double    # second getUserMedia call
node run.mjs rawmode   # ML-death camera passthrough
```

Uses MediaPipe Tasks Vision (Apache-2.0). Not affiliated with Google or Marvel.
