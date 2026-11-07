/**
 * EyeVoice Browser-Based MediaPipe Eye Tracker
 * =============================================
 * Runs Google MediaPipe FaceLandmarker entirely CLIENT-SIDE in the browser.
 * - Requests camera permission from the user's browser
 * - Tracks 478 facial landmarks + 10 iris points at 30+ FPS via WebGL
 * - Computes gaze direction, blink detection, and draws live preview
 * - Zero server dependency — works on any hosted website (Render, Vercel, etc.)
 *
 * Feeds into the existing handleGazeData() pipeline so the rest of app.js
 * (dwell selection, card focus, blink-to-click) works identically.
 */

const MP_VISION_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs';
const MP_WASM_PATH  = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm';
const MP_MODEL_URL  = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task';

// ── MediaPipe Face Mesh landmark indices (matches Python eyetype/gaze.py) ──
const L_EYE_OUTER = 33,  L_EYE_INNER = 133;
const R_EYE_OUTER = 362, R_EYE_INNER = 263;
const L_EYE_TOP = [160, 158], L_EYE_BOT = [153, 144];
const R_EYE_TOP = [385, 387], R_EYE_BOT = [373, 380];
const L_IRIS = [468, 469, 470, 471, 472];
const R_IRIS = [473, 474, 475, 476, 477];
const L_CONTOUR = [33, 160, 158, 133, 153, 144];
const R_CONTOUR = [362, 385, 387, 263, 373, 380];

// ── State ──
let faceLandmarker = null;
let videoEl  = null;
let canvas   = null;
let ctx      = null;
let running  = false;
let animId   = null;

// Smoothing (One Euro simplified)
let sU = 0, sV = 0;
const ALPHA = 0.28;

// Auto-centre calibration
let centSamples = [];
let cU = 0, cV = 0;

// FPS counter
let fCount = 0, fpsVal = 0, fpsT = 0;

// Blink detector
let closedN = 0, blinkT = 0;

// ── Helpers ──
function avg(lm, ids) {
  let x = 0, y = 0;
  for (const i of ids) { x += lm[i].x; y += lm[i].y; }
  return { x: x / ids.length, y: y / ids.length };
}

// ── Initialisation ──
async function initBrowserTracker() {
  const status = document.getElementById('hud-status');
  const hud    = document.getElementById('camera-hud');
  if (status) status.textContent = '● Loading MediaPipe model…';
  if (hud)    hud.style.display = 'block';

  try {
    // Dynamic import of MediaPipe Vision from CDN
    const vision = await import(MP_VISION_CDN);
    const { FaceLandmarker, FilesetResolver } = vision;

    const fileset = await FilesetResolver.forVisionTasks(MP_WASM_PATH);

    faceLandmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MP_MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    });

    if (status) status.textContent = '● Starting camera…';

    // Get DOM elements
    videoEl = document.getElementById('tracker-video');
    canvas  = document.getElementById('tracker-canvas');
    ctx     = canvas ? canvas.getContext('2d') : null;

    await startCamera();

  } catch (err) {
    console.error('Browser tracker init failed:', err);
    if (status) status.textContent = '● Model load failed';
    fallbackToMouse('MediaPipe could not load. Using click/touch mode.');
  }
}

async function startCamera() {
  const status = document.getElementById('hud-status');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });

    videoEl.srcObject = stream;
    videoEl.addEventListener('loadeddata', () => {
      running = true;
      fpsT = performance.now();
      processFrame();
      if (status) { status.textContent = '● Face & Eyes Tracked'; status.style.color = '#3ddc84'; }
    });
    await videoEl.play();

  } catch (err) {
    console.error('Camera access denied:', err);
    if (status) status.textContent = '● Camera denied';
    fallbackToMouse('Camera permission needed for eye tracking. Using click/touch mode.');
  }
}

function fallbackToMouse(msg) {
  if (typeof showToast === 'function') showToast(msg);
  const btn = document.getElementById('gaze-mode-btn');
  if (btn) { btn.textContent = '🖱️ Gaze: CLICK / TOUCH'; btn.classList.remove('active-gaze'); }
  // Set global so app.js knows
  try { gazeSource = 'mouse'; } catch(_) {}
}

// ── Frame loop ──
function processFrame() {
  if (!running || !faceLandmarker || !videoEl || videoEl.readyState < 2) {
    animId = requestAnimationFrame(processFrame);
    return;
  }

  const now = performance.now();
  const result = faceLandmarker.detectForVideo(videoEl, now);

  // FPS
  fCount++;
  if (now - fpsT >= 1000) { fpsVal = fCount; fCount = 0; fpsT = now; }
  const fpsEl = document.getElementById('hud-fps');
  if (fpsEl) fpsEl.textContent = fpsVal + ' FPS';

  // Draw live preview with landmark overlay
  drawPreview(result);

  if (result.faceLandmarks && result.faceLandmarks.length > 0) {
    const lm = result.faceLandmarks[0];
    const gaze  = computeGaze(lm);
    const blink = computeBlink(lm, now);

    const statusEl = document.getElementById('hud-status');
    if (statusEl) { statusEl.textContent = '● Face & Eyes Tracked'; statusEl.style.color = '#3ddc84'; }

    if (typeof handleGazeData === 'function') {
      handleGazeData({
        found: true,
        x: gaze.nx,
        y: gaze.ny,
        blink: blink.fired,
        ear: blink.ear,
        fps: fpsVal,
        camera_open: true,
        error: null,
        preview: null,
      });
    }
  } else {
    const statusEl = document.getElementById('hud-status');
    if (statusEl) { statusEl.textContent = '● Looking for face…'; statusEl.style.color = '#ffb74d'; }
  }

  animId = requestAnimationFrame(processFrame);
}

// ── Gaze computation (mirrors Python eyetype/gaze.py) ──
function computeGaze(lm) {
  // Iris centres
  const li = avg(lm, L_IRIS);
  const ri = avg(lm, R_IRIS);

  // Eye corners
  const lo = lm[L_EYE_OUTER], lin = lm[L_EYE_INNER];
  const ro = lm[R_EYE_OUTER], rin = lm[R_EYE_INNER];

  // Eye centres and widths
  const lcx = (lo.x + lin.x) / 2, lcy = (lo.y + lin.y) / 2;
  const rcx = (ro.x + rin.x) / 2, rcy = (ro.y + rin.y) / 2;
  const lw = Math.abs(lin.x - lo.x);
  const rw = Math.abs(ro.x - rin.x);

  // Horizontal offset in eye-width units
  const lu = lw > 0.001 ? (li.x - lcx) / lw : 0;
  const ru = rw > 0.001 ? (ri.x - rcx) / rw : 0;

  // Vertical: top/bottom lid midpoints
  const lt = avg(lm, L_EYE_TOP), lb = avg(lm, L_EYE_BOT);
  const rt = avg(lm, R_EYE_TOP), rb = avg(lm, R_EYE_BOT);
  const lh = Math.abs(lb.y - lt.y), rh = Math.abs(rb.y - rt.y);
  const lcvy = (lt.y + lb.y) / 2, rcvy = (rt.y + rb.y) / 2;
  const lv = lh > 0.001 ? (li.y - lcvy) / lh : 0;
  const rv = rh > 0.001 ? (ri.y - rcvy) / rh : 0;

  let u = (lu + ru) / 2;
  let v = (lv + rv) / 2;

  // Auto-centre (first 30 samples)
  if (centSamples.length < 30) {
    centSamples.push({ u, v });
    if (centSamples.length >= 30) {
      let su2 = 0, sv2 = 0;
      for (const s of centSamples) { su2 += s.u; sv2 += s.v; }
      cU = su2 / centSamples.length;
      cV = sv2 / centSamples.length;
    }
  }
  u -= cU;
  v -= cV;

  // EMA smoothing
  sU = sU * (1 - ALPHA) + u * ALPHA;
  sV = sV * (1 - ALPHA) + v * ALPHA;

  // Map to screen coords with gain + non-linear edge expansion
  const GH = 3.4, GV = 4.0;
  const du = sU * GH;
  const dv = sV * GV;
  let nx = 0.5 + du * (1.0 + 0.25 * Math.abs(du));
  let ny = 0.5 + dv * (1.0 + 0.25 * Math.abs(dv));
  nx = Math.max(0.02, Math.min(0.98, nx));
  ny = Math.max(0.02, Math.min(0.98, ny));

  return { nx, ny };
}

// ── Blink detection via Eye Aspect Ratio ──
function computeBlink(lm, now) {
  const lt = avg(lm, L_EYE_TOP), lb = avg(lm, L_EYE_BOT);
  const lo = lm[L_EYE_OUTER], lin = lm[L_EYE_INNER];
  const rt = avg(lm, R_EYE_TOP), rb = avg(lm, R_EYE_BOT);
  const ro = lm[R_EYE_OUTER], rin = lm[R_EYE_INNER];

  const lEAR = Math.abs(lb.y - lt.y) / Math.max(0.001, Math.abs(lin.x - lo.x));
  const rEAR = Math.abs(rb.y - rt.y) / Math.max(0.001, Math.abs(ro.x - rin.x));
  const ear = (lEAR + rEAR) / 2;

  let fired = false;
  if (ear < 0.15) {
    if (closedN === 0) blinkT = now;
    closedN++;
  } else {
    const dt = now - blinkT;
    if (closedN > 0 && dt >= 60 && dt <= 400) fired = true;
    closedN = 0;
  }
  return { ear, fired };
}

// ── Live preview with landmark overlay ──
function drawPreview(result) {
  if (!ctx || !canvas || !videoEl) return;
  const w = canvas.width, h = canvas.height;

  // Draw mirrored video frame
  ctx.save();
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(videoEl, 0, 0, w, h);
  ctx.restore();

  if (!result.faceLandmarks || result.faceLandmarks.length === 0) return;
  const lm = result.faceLandmarks[0];

  // Helper to draw a closed eye contour
  const drawContour = (ids, colour) => {
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ids.forEach((id, i) => {
      const px = w - lm[id].x * w, py = lm[id].y * h;
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.stroke();
  };

  // Eye contours (cyan)
  drawContour(L_CONTOUR, '#4CC9F0');
  drawContour(R_CONTOUR, '#4CC9F0');

  // Iris dots (bright green)
  const li = avg(lm, L_IRIS), ri = avg(lm, R_IRIS);
  ctx.fillStyle = '#3ddc84';
  [li, ri].forEach(p => {
    ctx.beginPath();
    ctx.arc(w - p.x * w, p.y * h, 3.5, 0, Math.PI * 2);
    ctx.fill();
  });

  // Key face points (faint blue)
  ctx.fillStyle = 'rgba(76, 201, 240, 0.5)';
  [1, 4, 61, 291, 10, 152].forEach(id => {
    ctx.beginPath();
    ctx.arc(w - lm[id].x * w, lm[id].y * h, 2, 0, Math.PI * 2);
    ctx.fill();
  });
}

// ── Public API (exposed to app.js) ──
window.initBrowserTracker = initBrowserTracker;

window.stopBrowserTracker = function () {
  running = false;
  if (animId) { cancelAnimationFrame(animId); animId = null; }
  if (videoEl && videoEl.srcObject) {
    videoEl.srcObject.getTracks().forEach(t => t.stop());
    videoEl.srcObject = null;
  }
};

window.recenterBrowserGaze = function () {
  centSamples = [];
  cU = 0; cV = 0;
  sU = 0; sV = 0;
  if (typeof showToast === 'function') showToast('🎯 Gaze re-centered!');
};

window.isBrowserTrackerRunning = function () { return running; };

// ── Auto-start when DOM is ready ──
function autoStart() {
  // Only start if gaze source is 'webcam' (check global from app.js)
  // app.js declares `let gazeSource` which isn't on window, so we check a data attribute
  const mode = document.body.getAttribute('data-gaze') || 'webcam';
  if (mode === 'webcam') {
    initBrowserTracker();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', autoStart);
} else {
  // Small delay so app.js globals are available
  setTimeout(autoStart, 100);
}

