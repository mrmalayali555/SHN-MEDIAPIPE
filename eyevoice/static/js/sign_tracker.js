// sign_tracker.js — Resilient MediaPipe Hand+Pose Tracking for Sign Language
// Loaded as <script type="module">. Exposes window.initSignTracker, window.stopSignTracker, window.isSignTrackerRunning.

const MP_VISION_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs';
const MP_WASM_PATH  = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm';
const HAND_MODEL    = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task';
const POSE_MODEL    = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task';
const FACE_MODEL    = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task';

// Hand landmark connection pairs
const HAND_CONNECTIONS = [
  // Thumb
  [0, 1], [1, 2], [2, 3], [3, 4],
  // Index
  [0, 5], [5, 6], [6, 7], [7, 8],
  // Middle
  [5, 9], [9, 10], [10, 11], [11, 12],
  // Ring
  [9, 13], [13, 14], [14, 15], [15, 16],
  // Pinky
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]
];

// Upper body connections
const POSE_CONNECTIONS = [
  [11, 12], [11, 13], [12, 14], [13, 15], [14, 16]
];

// Internal state
let handLandmarker = null;
let poseLandmarker = null;
let faceLandmarker = null;

let animFrameId   = null;
let running       = false;
let cameraStream  = null;

let lastFrameTime = 0;
let lastVideoTimestamp = 0;
let fpsValues     = [];
let currentFps    = 0;

function emitStatus(msg) {
  if (typeof window.onSignTrackerStatus === 'function') {
    window.onSignTrackerStatus(msg);
  }
}

/**
 * Load MediaPipe models with automatic GPU -> CPU fallback
 */
async function loadModels() {
  emitStatus('Loading MediaPipe Vision SDK…');
  const vision = await import(MP_VISION_CDN);
  const { HandLandmarker, PoseLandmarker, FaceLandmarker, FilesetResolver } = vision;

  emitStatus('Loading WASM runtime…');
  const fileset = await FilesetResolver.forVisionTasks(MP_WASM_PATH);

  // 1. Load HandLandmarker (Core Priority)
  emitStatus('Loading Hand Detector…');
  try {
    // Try GPU first
    handLandmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.35,
      minHandPresenceConfidence: 0.35,
      minTrackingConfidence: 0.35,
    });
    console.log('HandLandmarker initialized with GPU delegate');
  } catch (gpuErr) {
    console.warn('HandLandmarker GPU delegate failed, falling back to CPU:', gpuErr);
    try {
      handLandmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'CPU' },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.35,
        minHandPresenceConfidence: 0.35,
        minTrackingConfidence: 0.35,
      });
      console.log('HandLandmarker initialized with CPU delegate');
    } catch (cpuErr) {
      console.error('HandLandmarker failed on CPU too:', cpuErr);
      throw cpuErr;
    }
  }

  // 2. Load PoseLandmarker (Optional enhancement)
  try {
    poseLandmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'CPU' },
      runningMode: 'VIDEO',
    });
  } catch (e) {
    console.warn('Pose Landmarker optional load failed:', e);
    poseLandmarker = null;
  }

  // 3. Load FaceLandmarker (Optional enhancement)
  try {
    faceLandmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: FACE_MODEL, delegate: 'CPU' },
      runningMode: 'VIDEO',
      numFaces: 1,
    });
  } catch (e) {
    console.warn('Face Landmarker optional load failed:', e);
    faceLandmarker = null;
  }
}

/**
 * Draw vivid neon landmarks for hands
 */
function drawHandSkeleton(ctx, hands, handednesses, width, height) {
  if (!hands || hands.length === 0) return;

  for (let i = 0; i < hands.length; i++) {
    const lm = hands[i];
    const rawLabel = (handednesses && handednesses[i] && handednesses[i][0])
      ? handednesses[i][0].categoryName
      : 'Hand';

    // In mirrored canvas: MediaPipe "Left" appears on the viewer's right
    const isLeft = rawLabel === 'Left';
    const mainColor = isLeft ? '#10b981' : '#3b82f6'; // Emerald green vs Sky blue
    const glowColor = isLeft ? 'rgba(16, 185, 129, 0.4)' : 'rgba(59, 130, 246, 0.4)';

    // 1. Draw connecting bone lines
    ctx.save();
    ctx.strokeStyle = mainColor;
    ctx.lineWidth = 3.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = mainColor;
    ctx.shadowBlur = 8;

    for (const [s, e] of HAND_CONNECTIONS) {
      const p1 = lm[s];
      const p2 = lm[e];
      if (!p1 || !p2) continue;
      ctx.beginPath();
      ctx.moveTo(p1.x * width, p1.y * height);
      ctx.lineTo(p2.x * width, p2.y * height);
      ctx.stroke();
    }
    ctx.restore();

    // 2. Draw joints & fingertip rings
    for (let j = 0; j < lm.length; j++) {
      const pt = lm[j];
      const isTip = [4, 8, 12, 16, 20].includes(j);
      const radius = isTip ? 6 : 4;

      ctx.save();
      ctx.beginPath();
      ctx.arc(pt.x * width, pt.y * height, radius, 0, 2 * Math.PI);
      ctx.fillStyle = isTip ? '#ffffff' : mainColor;
      ctx.shadowColor = glowColor;
      ctx.shadowBlur = isTip ? 10 : 5;
      ctx.fill();
      ctx.strokeStyle = mainColor;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    }

    // 3. Hand label near wrist
    const wrist = lm[0];
    if (wrist) {
      ctx.save();
      ctx.font = 'bold 12px sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = 'black';
      ctx.shadowBlur = 4;
      ctx.fillText(`${rawLabel} Hand`, wrist.x * width - 25, Math.min(height - 10, wrist.y * height + 24));
      ctx.restore();
    }
  }
}

/**
 * Draw upper-body pose landmarks (shoulders, elbows, wrists)
 */
function drawUpperBodyPose(ctx, poses, width, height) {
  if (!poses || poses.length === 0) return;
  const lm = poses[0];
  if (!lm) return;

  ctx.save();
  ctx.strokeStyle = 'rgba(234, 179, 8, 0.7)'; // Amber
  ctx.lineWidth = 2.5;

  for (const [aIdx, bIdx] of POSE_CONNECTIONS) {
    const a = lm[aIdx];
    const b = lm[bIdx];
    if (!a || !b) continue;
    ctx.beginPath();
    ctx.moveTo(a.x * width, a.y * height);
    ctx.lineTo(b.x * width, b.y * height);
    ctx.stroke();
  }

  ctx.fillStyle = '#eab308';
  for (const idx of [11, 12, 13, 14, 15, 16]) {
    const pt = lm[idx];
    if (!pt) continue;
    ctx.beginPath();
    ctx.arc(pt.x * width, pt.y * height, 4, 0, 2 * Math.PI);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Main Camera & Tracker Initializer
 */
window.initSignTracker = async function initSignTracker(videoEl, canvasEl, onFrameCallback) {
  if (running) {
    emitStatus('Tracker already running');
    return;
  }

  // 1. Release any existing camera streams to avoid device conflicts
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  if (window.stopBrowserTracker) {
    try { window.stopBrowserTracker(); } catch (_) {}
  }

  // 2. Load models if not already loaded
  if (!handLandmarker) {
    try {
      await loadModels();
      emitStatus('MediaPipe Vision Ready ✓');
    } catch (err) {
      console.error('Failed to load MediaPipe models:', err);
      emitStatus('❌ MediaPipe load error: ' + err.message);
      return;
    }
  }

  // 3. Request webcam stream
  try {
    emitStatus('Opening webcam…');
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        facingMode: 'user',
      },
      audio: false,
    });
    videoEl.srcObject = cameraStream;
    videoEl.setAttribute('playsinline', '');
    videoEl.muted = true;
    await videoEl.play();

    // Wait for real video dimensions
    if (!videoEl.videoWidth) {
      await new Promise(resolve => {
        videoEl.onloadedmetadata = () => resolve();
        setTimeout(resolve, 500); // timeout fallback
      });
    }
  } catch (err) {
    console.error('Webcam access error:', err);
    emitStatus('❌ Webcam blocked or unavailable: ' + err.message);
    throw err;
  }

  // 4. Configure canvas
  const ctx = canvasEl.getContext('2d');
  canvasEl.width = videoEl.videoWidth || 640;
  canvasEl.height = videoEl.videoHeight || 480;

  running = true;
  lastFrameTime = 0;
  lastVideoTimestamp = 0;
  fpsValues = [];
  currentFps = 0;

  emitStatus('Tracking Active');

  // 5. Main Animation Frame Loop
  function processFrame() {
    if (!running) return;

    let now = performance.now();
    // Guarantee strictly increasing timestamp for MediaPipe
    if (now <= lastVideoTimestamp) {
      now = lastVideoTimestamp + 1;
    }
    lastVideoTimestamp = now;

    // Calculate FPS
    if (lastFrameTime > 0) {
      const delta = now - lastFrameTime;
      if (delta > 0) {
        fpsValues.push(1000 / delta);
        if (fpsValues.length > 20) fpsValues.shift();
        currentFps = fpsValues.reduce((a, b) => a + b, 0) / fpsValues.length;
      }
    }
    lastFrameTime = now;

    const width = canvasEl.width;
    const height = canvasEl.height;

    // Inference results
    let handResult = { landmarks: [], handednesses: [], worldLandmarks: [] };
    let poseResult = { landmarks: [], worldLandmarks: [] };
    let faceResult = { faceLandmarks: [], faceBlendshapes: [] };

    if (handLandmarker && videoEl.readyState >= 2) {
      try {
        handResult = handLandmarker.detectForVideo(videoEl, Math.round(now));
      } catch (err) {
        // Skip individual frame glitch
      }
    }

    if (poseLandmarker && videoEl.readyState >= 2) {
      try {
        poseResult = poseLandmarker.detectForVideo(videoEl, Math.round(now));
      } catch (_) {}
    }

    if (faceLandmarker && videoEl.readyState >= 2) {
      try {
        faceResult = faceLandmarker.detectForVideo(videoEl, Math.round(now));
      } catch (_) {}
    }

    // ── Render ──
    ctx.save();
    // Mirror so user sees a natural reflection
    ctx.scale(-1, 1);
    ctx.translate(-width, 0);

    // Draw video feed
    ctx.drawImage(videoEl, 0, 0, width, height);

    // Draw skeleton overlays
    drawHandSkeleton(ctx, handResult.landmarks, handResult.handednesses, width, height);
    if (poseResult.landmarks) {
      drawUpperBodyPose(ctx, poseResult.landmarks, width, height);
    }

    ctx.restore();

    // ── Draw HUD elements (unmirrored) ──
    ctx.save();
    // FPS chip
    ctx.font = 'bold 13px monospace';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'black';
    ctx.shadowBlur = 4;
    ctx.fillText(`${Math.round(currentFps)} FPS`, 12, 22);

    // Hands detected badge on canvas
    const handCount = handResult.landmarks ? handResult.landmarks.length : 0;
    if (handCount > 0) {
      ctx.fillStyle = '#10b981';
      ctx.fillText(`● ${handCount} Hand${handCount > 1 ? 's' : ''} Tracked`, 12, 42);
    } else {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.fillText(`○ Show hands to sign`, 12, 42);
    }
    ctx.restore();

    // Update FPS element in DOM if present
    const fpsEl = document.getElementById('sign-fps');
    if (fpsEl) fpsEl.textContent = `${Math.round(currentFps)} FPS`;

    // ── Dispatch callback to sign recognizer ──
    if (typeof onFrameCallback === 'function') {
      onFrameCallback({
        hands:       handResult.landmarks || [],
        handedness:  handResult.handednesses || [],
        worldHands:  handResult.worldLandmarks || [],
        pose:        poseResult.landmarks || [],
        worldPose:   poseResult.worldLandmarks || [],
        face:        faceResult.faceLandmarks || [],
        blendshapes: faceResult.faceBlendshapes || [],
        timestamp:   now,
      });
    }

    animFrameId = requestAnimationFrame(processFrame);
  }

  animFrameId = requestAnimationFrame(processFrame);
};

window.stopSignTracker = function stopSignTracker() {
  running = false;

  if (animFrameId !== null) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }

  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
  }

  emitStatus('Camera Stopped');
};

window.isSignTrackerRunning = function isSignTrackerRunning() {
  return running;
};

window.captureSignFrame = function captureSignFrame() {
  const canvas = document.getElementById('sign-canvas');
  if (!canvas || !running) return null;
  try {
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch (e) {
    console.warn('Frame capture failed:', e);
    return null;
  }
};
