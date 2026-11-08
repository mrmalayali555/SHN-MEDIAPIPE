// sign_tracker.js — Client-side MediaPipe Hand+Pose+Face tracking for sign language recognition
// Loaded as <script type="module">. Exposes window.initSignTracker, window.stopSignTracker, window.isSignTrackerRunning.

const MP_VISION_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs';
const MP_WASM_PATH  = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm';
const HAND_MODEL    = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task';
const POSE_MODEL    = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task';
const FACE_MODEL    = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task';

// ── Internal state ──────────────────────────────────────────────────────────────
let handLandmarker  = null;
let poseLandmarker  = null;
let faceLandmarker  = null;
let drawingUtils    = null;
let HAND_CONNECTIONS_REF = null;

let animFrameId     = null;
let running         = false;
let stream          = null;

let lastFrameTime   = 0;
let fpsValues       = [];
let currentFps      = 0;

// ── Helper: emit status ─────────────────────────────────────────────────────────
function emitStatus(msg) {
  if (typeof window.onSignTrackerStatus === 'function') {
    window.onSignTrackerStatus(msg);
  }
}

// ── Load SDK & models ───────────────────────────────────────────────────────────
async function loadModels() {
  emitStatus('Loading MediaPipe SDK…');
  const vision = await import(MP_VISION_CDN);
  const { HandLandmarker, PoseLandmarker, FaceLandmarker, FilesetResolver, DrawingUtils } = vision;

  HAND_CONNECTIONS_REF = HandLandmarker.HAND_CONNECTIONS;

  emitStatus('Loading WASM fileset…');
  const fileset = await FilesetResolver.forVisionTasks(MP_WASM_PATH);

  // Load each model independently — if one fails the others still work
  try {
    emitStatus('Loading Hand model…');
    handLandmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.5,
    });
  } catch (err) {
    console.error('Hand model failed to load:', err);
    emitStatus('⚠ Hand model failed to load');
    handLandmarker = null;
  }

  try {
    emitStatus('Loading Pose model…');
    poseLandmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'GPU' },
      runningMode: 'VIDEO',
    });
  } catch (err) {
    console.error('Pose model failed to load:', err);
    emitStatus('⚠ Pose model failed to load');
    poseLandmarker = null;
  }

  try {
    emitStatus('Loading Face model…');
    faceLandmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: FACE_MODEL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
    });
  } catch (err) {
    console.error('Face model failed to load:', err);
    emitStatus('⚠ Face model failed to load');
    faceLandmarker = null;
  }

  // DrawingUtils needs a canvas context — we'll create it later per-frame,
  // but store the constructor ref so we can instantiate it once we have the ctx.
  return DrawingUtils;
}

// ── Drawing helpers ─────────────────────────────────────────────────────────────

function drawHandLandmarks(ctx, hands, handednesses, width, height) {
  if (!hands || hands.length === 0) return;

  for (let i = 0; i < hands.length; i++) {
    const landmarks = hands[i];
    const label = handednesses && handednesses[i] && handednesses[i][0]
      ? handednesses[i][0].categoryName
      : 'Unknown';

    // MediaPipe reports handedness from the camera's POV, so
    // "Left" in result = user's left hand. We colour accordingly.
    const color = label === 'Left' ? '#22c55e' : '#3b82f6';

    // Draw connections
    if (HAND_CONNECTIONS_REF) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      for (const conn of HAND_CONNECTIONS_REF) {
        const a = landmarks[conn.start];
        const b = landmarks[conn.end];
        if (!a || !b) continue;
        ctx.beginPath();
        ctx.moveTo(a.x * width, a.y * height);
        ctx.lineTo(b.x * width, b.y * height);
        ctx.stroke();
      }
    }

    // Draw dots
    ctx.fillStyle = color;
    for (const lm of landmarks) {
      ctx.beginPath();
      ctx.arc(lm.x * width, lm.y * height, 3, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
}

function drawUpperBodyPose(ctx, poses, width, height) {
  if (!poses || poses.length === 0) return;
  const lm = poses[0]; // first person
  if (!lm) return;

  // Upper-body connections: shoulders(11-12), shoulder→elbow(11-13, 12-14), elbow→wrist(13-15, 14-16)
  const connections = [
    [11, 12],
    [11, 13],
    [12, 14],
    [13, 15],
    [14, 16],
  ];

  ctx.strokeStyle = '#eab308';
  ctx.lineWidth = 3;

  for (const [aIdx, bIdx] of connections) {
    const a = lm[aIdx];
    const b = lm[bIdx];
    if (!a || !b) continue;
    ctx.beginPath();
    ctx.moveTo(a.x * width, a.y * height);
    ctx.lineTo(b.x * width, b.y * height);
    ctx.stroke();
  }

  // Draw dots on the upper-body keypoints
  ctx.fillStyle = '#eab308';
  for (const idx of [11, 12, 13, 14, 15, 16]) {
    const pt = lm[idx];
    if (!pt) continue;
    ctx.beginPath();
    ctx.arc(pt.x * width, pt.y * height, 4, 0, 2 * Math.PI);
    ctx.fill();
  }
}

function drawFps(ctx, fps) {
  const text = `${Math.round(fps)} FPS`;
  ctx.font = '16px monospace';
  ctx.shadowColor = 'black';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetX = 1;
  ctx.shadowOffsetY = 1;
  ctx.fillStyle = 'white';
  ctx.fillText(text, 10, 22);
  // Reset shadow
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

// ── FPS tracking ────────────────────────────────────────────────────────────────
function updateFps(now) {
  if (lastFrameTime > 0) {
    const delta = now - lastFrameTime;
    if (delta > 0) {
      fpsValues.push(1000 / delta);
      if (fpsValues.length > 30) fpsValues.shift();
      currentFps = fpsValues.reduce((a, b) => a + b, 0) / fpsValues.length;
    }
  }
  lastFrameTime = now;
}

// ── Main init ───────────────────────────────────────────────────────────────────
window.initSignTracker = async function initSignTracker(videoEl, canvasEl, onFrameCallback) {
  if (running) {
    emitStatus('Tracker already running');
    return;
  }

  let DrawingUtilsClass;
  try {
    DrawingUtilsClass = await loadModels();
    emitStatus('Models loaded ✓');
  } catch (err) {
    console.error('Failed to load MediaPipe SDK:', err);
    emitStatus('❌ Failed to load MediaPipe SDK: ' + err.message);
    return;
  }

  // Start camera
  try {
    emitStatus('Requesting camera…');
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
    });
    videoEl.srcObject = stream;
    videoEl.setAttribute('playsinline', '');
    await videoEl.play();
  } catch (err) {
    console.error('Camera access denied:', err);
    emitStatus('❌ Camera access denied: ' + err.message);
    return;
  }

  // Set up canvas
  const ctx = canvasEl.getContext('2d');
  canvasEl.width = videoEl.videoWidth || 640;
  canvasEl.height = videoEl.videoHeight || 480;

  running = true;
  lastFrameTime = 0;
  fpsValues = [];
  currentFps = 0;

  emitStatus('Tracking started');

  // ── Frame loop ──────────────────────────────────────────────────────────────
  function processFrame() {
    if (!running) return;

    const now = performance.now();
    updateFps(now);

    const width = canvasEl.width;
    const height = canvasEl.height;

    // Detect
    let handResult = { landmarks: [], handednesses: [], worldLandmarks: [] };
    let poseResult = { landmarks: [], worldLandmarks: [] };
    let faceResult = { faceLandmarks: [], faceBlendshapes: [] };

    if (handLandmarker && videoEl.readyState >= 2) {
      try {
        handResult = handLandmarker.detectForVideo(videoEl, now);
      } catch (_) { /* skip frame */ }
    }
    if (poseLandmarker && videoEl.readyState >= 2) {
      try {
        poseResult = poseLandmarker.detectForVideo(videoEl, now);
      } catch (_) { /* skip frame */ }
    }
    if (faceLandmarker && videoEl.readyState >= 2) {
      try {
        faceResult = faceLandmarker.detectForVideo(videoEl, now);
      } catch (_) { /* skip frame */ }
    }

    // ── Draw ────────────────────────────────────────────────────────────────
    ctx.save();
    // Mirror the canvas so the user sees a natural reflection
    ctx.scale(-1, 1);
    ctx.translate(-width, 0);

    // Draw video frame
    ctx.drawImage(videoEl, 0, 0, width, height);

    // Overlay landmarks
    drawHandLandmarks(ctx, handResult.landmarks, handResult.handednesses, width, height);
    drawUpperBodyPose(ctx, poseResult.landmarks, width, height);

    ctx.restore();

    // FPS (drawn un-mirrored so text is readable)
    drawFps(ctx, currentFps);

    // ── Callback ────────────────────────────────────────────────────────────
    if (typeof onFrameCallback === 'function') {
      onFrameCallback({
        hands:       handResult.landmarks,
        handedness:  handResult.handednesses,
        worldHands:  handResult.worldLandmarks,
        pose:        poseResult.landmarks,
        worldPose:   poseResult.worldLandmarks,
        face:        faceResult.faceLandmarks,
        blendshapes: faceResult.faceBlendshapes,
        timestamp:   now,
      });
    }

    animFrameId = requestAnimationFrame(processFrame);
  }

  animFrameId = requestAnimationFrame(processFrame);
};

// ── Stop ────────────────────────────────────────────────────────────────────────
window.stopSignTracker = function stopSignTracker() {
  running = false;

  if (animFrameId !== null) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }

  if (stream) {
    for (const track of stream.getTracks()) {
      track.stop();
    }
    stream = null;
  }

  // Clear canvas if we still have a reference through closure — caller can also clear manually
  emitStatus('Tracking stopped');
};

// ── Query ───────────────────────────────────────────────────────────────────────
window.isSignTrackerRunning = function isSignTrackerRunning() {
  return running;
};

