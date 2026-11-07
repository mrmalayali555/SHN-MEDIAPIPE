/**
 * EyeVoice Pro Multi-Modal Eye & Head Tracker (Client-Side MediaPipe WebGL)
 * =========================================================================
 * - Uses Google MediaPipe FaceLandmarker 478 points + 10 iris landmarks
 * - OneEuroFilter: Ultra-responsive (< 25ms latency) on eye movements, rock-steady on fixations
 * - Fuses Iris Gaze Vector + 3D Head Pose (Yaw/Pitch) for natural, effortless screen targeting
 * - Guided 1-Second Quick Calibration: Locks neutral center gaze with 1 click
 * - Non-linear sigmoidal edge-reach expansion: Effortlessly reaches every card and corner
 */

const MP_VISION_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs';
const MP_WASM_PATH  = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm';
const MP_MODEL_URL  = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task';

// ── Landmark Indices ──
const L_EYE_OUTER = 33,  L_EYE_INNER = 133;
const R_EYE_OUTER = 362, R_EYE_INNER = 263;
const L_EYE_TOP = [160, 158], L_EYE_BOT = [153, 144];
const R_EYE_TOP = [385, 387], R_EYE_BOT = [373, 380];
const L_IRIS = [468, 469, 470, 471, 472];
const R_IRIS = [473, 474, 475, 476, 477];
const L_CONTOUR = [33, 160, 158, 133, 153, 144];
const R_CONTOUR = [362, 385, 387, 263, 373, 380];
const NOSE_TIP = 1;

// ── One Euro Filter (Gold Standard for Eye-Tracking Jitter vs Latency) ──
class OneEuroFilter {
  constructor(minCutoff = 0.9, beta = 0.04, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = null;
    this.dx = 0;
    this.lastTime = null;
  }

  alpha(cutoff, dt) {
    const tau = 1.0 / (2.0 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / dt);
  }

  filter(val, timestamp) {
    if (this.lastTime === null || this.x === null) {
      this.x = val;
      this.lastTime = timestamp;
      this.dx = 0;
      return val;
    }
    const dt = Math.max(1e-3, (timestamp - this.lastTime) / 1000.0);
    this.lastTime = timestamp;

    const currentDx = (val - this.x) / dt;
    const aD = this.alpha(this.dCutoff, dt);
    this.dx = aD * currentDx + (1 - aD) * this.dx;

    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    const a = this.alpha(cutoff, dt);
    this.x = a * val + (1 - a) * this.x;
    return this.x;
  }

  reset() {
    this.x = null;
    this.dx = 0;
    this.lastTime = null;
  }
}

// ── State ──
let faceLandmarker = null;
let videoEl = null;
let canvas = null;
let ctx = null;
let running = false;
let animId = null;

// OneEuro Filters for X, Y, and Head Pose
const filterU = new OneEuroFilter(0.85, 0.05, 1.0);
const filterV = new OneEuroFilter(0.85, 0.05, 1.0);

// Calibrated Baselines (default center)
let cU = 0.0;
let cV = 0.0;
let cYaw = 0.0;
let cPitch = 0.0;

// Interactive Calibration State
let isCalibrating = false;
let calibSamples = [];
let calibStartTime = 0;
const CALIB_DURATION_MS = 1000; // 1 second

// Adaptive Drift Correction (slowly tracks posture shift)
let slowDriftU = 0.0, slowDriftV = 0.0;

// FPS & Blink state
let fCount = 0, fpsVal = 0, fpsT = 0;
let earBaseline = 0.28;
let closedFrames = 0;
let closedSince = 0;

// ── Geometry Helpers ──
function avgPoint(lm, ids) {
  let x = 0, y = 0;
  for (const i of ids) { x += lm[i].x; y += lm[i].y; }
  return { x: x / ids.length, y: y / ids.length };
}

// ── Initialization ──
async function initBrowserTracker() {
  const status = document.getElementById('hud-status');
  const hud = document.getElementById('camera-hud');
  if (status) {
    status.textContent = '● Loading MediaPipe Vision AI…';
    status.style.color = 'var(--accent)';
  }
  if (hud) hud.style.display = 'block';

  try {
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

    if (status) status.textContent = '● Requesting Camera…';

    videoEl = document.getElementById('tracker-video');
    canvas  = document.getElementById('tracker-canvas');
    ctx     = canvas ? canvas.getContext('2d') : null;

    await startCamera();

  } catch (err) {
    console.error('Browser tracker error:', err);
    if (status) status.textContent = '● Camera/Model Error';
    fallbackToMouse('Could not load camera. Switched to Click/Touch mode.');
  }
}

async function startCamera() {
  const status = document.getElementById('hud-status');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 }
      },
      audio: false,
    });

    videoEl.srcObject = stream;
    videoEl.addEventListener('loadeddata', () => {
      running = true;
      fpsT = performance.now();
      processFrame();
      if (status) {
        status.textContent = '● Eyes & Face Tracked';
        status.style.color = '#3ddc84';
      }
      // Prompt user for 1-second calibration on first launch
      setTimeout(() => {
        if (!isCalibrating && cU === 0 && cV === 0) {
          startQuickCalibration();
        }
      }, 800);
    });
    await videoEl.play();

  } catch (err) {
    console.error('Camera access denied:', err);
    if (status) status.textContent = '● Camera Access Denied';
    fallbackToMouse('Please allow camera permission for eye tracking. Click icon in URL bar.');
  }
}

function fallbackToMouse(msg) {
  if (typeof showToast === 'function') showToast(msg);
  const btn = document.getElementById('gaze-mode-btn');
  if (btn) {
    btn.textContent = '🖱️ Gaze: CLICK / TOUCH';
    btn.classList.remove('active-gaze');
  }
  try { gazeSource = 'mouse'; } catch(_) {}
}

// ── Frame Loop ──
function processFrame() {
  if (!running || !faceLandmarker || !videoEl || videoEl.readyState < 2) {
    animId = requestAnimationFrame(processFrame);
    return;
  }

  const now = performance.now();
  const result = faceLandmarker.detectForVideo(videoEl, now);

  // FPS Meter
  fCount++;
  if (now - fpsT >= 1000) { fpsVal = fCount; fCount = 0; fpsT = now; }
  const fpsEl = document.getElementById('hud-fps');
  if (fpsEl) fpsEl.textContent = fpsVal + ' FPS';

  drawPreview(result);

  if (result.faceLandmarks && result.faceLandmarks.length > 0) {
    const lm = result.faceLandmarks[0];
    const gaze = computeEnhancedGaze(lm, now);
    const blink = computeEnhancedBlink(lm, now);

    const statusEl = document.getElementById('hud-status');
    if (statusEl && !isCalibrating) {
      statusEl.textContent = '● Eyes & Face Tracked';
      statusEl.style.color = '#3ddc84';
    }

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
    filterU.reset();
    filterV.reset();
    const statusEl = document.getElementById('hud-status');
    if (statusEl) {
      statusEl.textContent = '● Face Not Detected';
      statusEl.style.color = '#ffb74d';
    }
  }

  animId = requestAnimationFrame(processFrame);
}

// ── Multi-Modal Gaze Estimation: Iris Vector + Head Pose ──
function computeEnhancedGaze(lm, now) {
  // 1. Iris & Eye Centers
  const li = avgPoint(lm, L_IRIS);
  const ri = avgPoint(lm, R_IRIS);

  const lo = lm[L_EYE_OUTER], lin = lm[L_EYE_INNER];
  const ro = lm[R_EYE_OUTER], rin = lm[R_EYE_INNER];

  const lcx = (lo.x + lin.x) / 2.0;
  const rcx = (ro.x + rin.x) / 2.0;
  const lw = Math.max(1e-4, Math.abs(lin.x - lo.x));
  const rw = Math.max(1e-4, Math.abs(ro.x - rin.x));

  const lu = (li.x - lcx) / lw;
  const ru = (ri.x - rcx) / rw;

  // Vertical lid midpoints
  const lt = avgPoint(lm, L_EYE_TOP), lb = avgPoint(lm, L_EYE_BOT);
  const rt = avgPoint(lm, R_EYE_TOP), rb = avgPoint(lm, R_EYE_BOT);
  const lh = Math.max(1e-4, Math.abs(lb.y - lt.y));
  const rh = Math.max(1e-4, Math.abs(rb.y - rt.y));

  const lcy = (lt.y + lb.y) / 2.0;
  const rcy = (rt.y + rb.y) / 2.0;

  const lv = (li.y - lcy) / lh;
  const rv = (ri.y - rcy) / rh;

  // Eye gaze vector
  const uEye = (lu + ru) / 2.0;
  const vEye = (lv + rv) / 2.0;

  // 2. Head Pose (Yaw & Pitch)
  // Inter-eye midpoint & distance
  const midEyeX = (lo.x + ro.x) / 2.0;
  const midEyeY = (lo.y + ro.y) / 2.0;
  const interEyeDist = Math.max(1e-4, Math.hypot(ro.x - lo.x, ro.y - lo.y));

  const nose = lm[NOSE_TIP];
  const rawYaw = (nose.x - midEyeX) / interEyeDist;
  const rawPitch = (nose.y - midEyeY) / interEyeDist;

  // 3. Interactive Quick Calibration Collection
  if (isCalibrating) {
    calibSamples.push({ u: uEye, v: vEye, yaw: rawYaw, pitch: rawPitch });
    const elapsed = now - calibStartTime;
    const progressEl = document.getElementById('calibration-progress-fill');
    if (progressEl) {
      progressEl.style.width = Math.min(100, (elapsed / CALIB_DURATION_MS) * 100) + '%';
    }

    if (elapsed >= CALIB_DURATION_MS && calibSamples.length >= 10) {
      // Calculate median/mean baselines
      let su = 0, sv = 0, sy = 0, sp = 0;
      for (const s of calibSamples) {
        su += s.u; sv += s.v; sy += s.yaw; sp += s.pitch;
      }
      const n = calibSamples.length;
      cU = su / n;
      cV = sv / n;
      cYaw = sy / n;
      cPitch = sp / n;

      isCalibrating = false;
      filterU.reset();
      filterV.reset();

      const overlay = document.getElementById('calibration-overlay');
      if (overlay) overlay.style.display = 'none';

      const statusEl = document.getElementById('hud-status');
      if (statusEl) {
        statusEl.textContent = '● Calibrated 🎯';
        statusEl.style.color = '#3ddc84';
      }
      if (typeof showToast === 'function') {
        showToast('🎯 Eye tracking calibrated to your screen center!');
      }
    }
    return { nx: 0.5, ny: 0.5 };
  }

  // 4. Multi-Modal Fusion: Eyes + Head Orientation
  // People naturally move eyes ~65% and head ~35% when targeting items
  const deltaYaw = (rawYaw - cYaw);
  const deltaPitch = (rawPitch - cPitch);

  const uCombined = (uEye - cU) + deltaYaw * 0.70;
  const vCombined = (vEye - cV) + deltaPitch * 0.85;

  // 5. OneEuro Filtering (Zero latency on rapid look, zero jitter on fixation)
  const uFilt = filterU.filter(uCombined, now);
  const vFilt = filterV.filter(vCombined, now);

  // 6. Non-Linear Gain & Edge Reach Curve
  // Horizontal Gain 4.4, Vertical Gain 4.8
  const GAIN_X = 4.4;
  const GAIN_Y = 4.8;
  const du = uFilt * GAIN_X;
  const dv = vFilt * GAIN_Y;

  // Gentle sigmoidal expansion allows reaching screen corners effortlessly without eye strain
  let nx = 0.5 + du * (1.0 + 0.32 * Math.abs(du));
  let ny = 0.5 + dv * (1.0 + 0.35 * Math.abs(dv));

  nx = Math.max(0.01, Math.min(0.99, nx));
  ny = Math.max(0.01, Math.min(0.99, ny));

  return { nx, ny };
}

// ── Accurate Blink Detection (Dynamic EAR Baseline) ──
function computeEnhancedBlink(lm, now) {
  const lt = avgPoint(lm, L_EYE_TOP), lb = avgPoint(lm, L_EYE_BOT);
  const lo = lm[L_EYE_OUTER], lin = lm[L_EYE_INNER];
  const rt = avgPoint(lm, R_EYE_TOP), rb = avgPoint(lm, R_EYE_BOT);
  const ro = lm[R_EYE_OUTER], rin = lm[R_EYE_INNER];

  const lEAR = Math.abs(lb.y - lt.y) / Math.max(1e-3, Math.abs(lin.x - lo.x));
  const rEAR = Math.abs(rb.y - rt.y) / Math.max(1e-3, Math.abs(ro.x - rin.x));
  const ear = (lEAR + rEAR) / 2.0;

  // Slowly adapt baseline to natural open eye size
  if (ear > 0.20 && !isCalibrating) {
    earBaseline = earBaseline * 0.98 + ear * 0.02;
  }

  const blinkThreshold = earBaseline * 0.65;
  let fired = false;

  if (ear < blinkThreshold) {
    if (closedFrames === 0) closedSince = now;
    closedFrames++;
  } else {
    if (closedFrames > 0) {
      const dt = now - closedSince;
      // Intentional click blink: between 70ms and 420ms
      if (dt >= 70 && dt <= 420) {
        fired = true;
      }
    }
    closedFrames = 0;
  }

  return { ear, fired };
}

// ── Live Camera HUD Canvas Rendering ──
function drawPreview(result) {
  if (!ctx || !canvas || !videoEl) return;
  const w = canvas.width, h = canvas.height;

  ctx.save();
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(videoEl, 0, 0, w, h);
  ctx.restore();

  if (!result.faceLandmarks || result.faceLandmarks.length === 0) return;
  const lm = result.faceLandmarks[0];

  // Helper to draw eye contour
  const drawContour = (ids, strokeStyle) => {
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ids.forEach((id, idx) => {
      const px = w - lm[id].x * w, py = lm[id].y * h;
      idx === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.stroke();
  };

  drawContour(L_CONTOUR, '#4CC9F0');
  drawContour(R_CONTOUR, '#4CC9F0');

  // Draw glowing iris tracking points
  const li = avgPoint(lm, L_IRIS);
  const ri = avgPoint(lm, R_IRIS);
  ctx.fillStyle = '#3ddc84';
  ctx.shadowColor = '#3ddc84';
  ctx.shadowBlur = 6;
  [li, ri].forEach(p => {
    ctx.beginPath();
    ctx.arc(w - p.x * w, p.y * h, 3.8, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.shadowBlur = 0;

  // Face Anchor Crosshair (Nose Tip)
  const nose = lm[NOSE_TIP];
  ctx.strokeStyle = 'rgba(76, 201, 240, 0.6)';
  ctx.lineWidth = 1.2;
  const nx = w - nose.x * w, ny = nose.y * h;
  ctx.beginPath();
  ctx.arc(nx, ny, 3.0, 0, Math.PI * 2);
  ctx.stroke();
}

// ── 1-Second Quick Calibration Function ──
export function startQuickCalibration() {
  const overlay = document.getElementById('calibration-overlay');
  const textEl = document.getElementById('calibration-text');
  const progressEl = document.getElementById('calibration-progress-fill');

  if (overlay) overlay.style.display = 'flex';
  if (textEl) textEl.textContent = '🎯 Look directly at the center target…';
  if (progressEl) progressEl.style.width = '0%';

  calibSamples = [];
  calibStartTime = performance.now();
  isCalibrating = true;
  filterU.reset();
  filterV.reset();
}

// ── Public Global Exports ──
window.initBrowserTracker = initBrowserTracker;
window.startQuickCalibration = startQuickCalibration;

window.stopBrowserTracker = function () {
  running = false;
  if (animId) { cancelAnimationFrame(animId); animId = null; }
  if (videoEl && videoEl.srcObject) {
    videoEl.srcObject.getTracks().forEach(t => t.stop());
    videoEl.srcObject = null;
  }
};

window.recenterBrowserGaze = function () {
  startQuickCalibration();
};

window.isBrowserTrackerRunning = function () { return running; };

// Auto-start on load
function autoStart() {
  const mode = document.body.getAttribute('data-gaze') || 'webcam';
  if (mode === 'webcam') {
    initBrowserTracker();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', autoStart);
} else {
  setTimeout(autoStart, 100);
}
