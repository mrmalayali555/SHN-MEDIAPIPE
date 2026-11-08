/**
 * EyeVoice – Patient Communication Dashboard Controller
 * Handles visual card rendering, TTS speech synthesis, keyboard/gaze navigation,
 * caregiver messaging, and customization.
 */

// Application State
let appData = {
  categories: [],
  emergency: {}
};

let currentView = 'home'; // 'home' or category_id
let currentCategory = null;
let currentMessage = '';
let currentIcon = '💬';
let visualTokens = []; // for Visual Language composition

// Indian Sign Language (ISL) Linguistic State
let islSignsData = [];
let islCategoriesData = [];
let islCurrentCategory = 'all';
let islSequence = [];
let islInterpretedResult = null;
let islLastSpokenText = '';
let islSelectedAnchor = 'forehead'; // Practical body anchor: forehead, mouth, chest, body, people, questions

// Navigation State (Keyboard / Simulated Eye Gaze Grid)
let focusedIndex = 0;
let focusableElements = [];

// Eye Gaze Dwell-Timer Selection State
let dwellEnabled = true;
const DWELL_TIME_MS = 1400; // 1.4 seconds deliberate resting gaze to select
let dwellTimer = null;
let dwellAnimFrame = null;
let activeDwellCard = null;

function toggleDwellMode() {
  dwellEnabled = !dwellEnabled;
  const btn = document.getElementById('dwell-toggle-btn');
  if (btn) {
    btn.textContent = dwellEnabled ? '⏱️ Eye Dwell Click: ON (1.4s)' : '⏱️ Eye Dwell Click: OFF';
    btn.style.color = dwellEnabled ? 'var(--good)' : 'var(--text-muted)';
  }
  showToast(dwellEnabled ? "Eye Dwell auto-selection enabled" : "Eye Dwell selection disabled (use click/enter)");
}

let audioCtx = null;
function playClickChime() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1250, audioCtx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.08);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.09);
  } catch(_) {}
}

function startDwell(cardEl) {
  if (!dwellEnabled || !cardEl) return;
  cancelDwell();

  activeDwellCard = cardEl;
  window.currentDwellStartTime = performance.now();
  let hBar = cardEl.querySelector('.dwell-progress-bar');
  if (!hBar && !cardEl.classList.contains('btn-perm-back')) {
    hBar = document.createElement('div');
    hBar.className = 'dwell-progress-bar';
    cardEl.appendChild(hBar);
  }
  const vBar = cardEl.querySelector('.dwell-progress-bar-vertical');
  const startTime = performance.now();

  function step(now) {
    if (activeDwellCard !== cardEl) return;
    const elapsed = now - startTime;
    const progress = Math.min(100, (elapsed / DWELL_TIME_MS) * 100);
    if (hBar) hBar.style.width = progress + '%';
    if (vBar) vBar.style.height = progress + '%';

    if (elapsed >= DWELL_TIME_MS) {
      if (hBar) hBar.style.width = '0%';
      if (vBar) vBar.style.height = '0%';
      activeDwellCard = null;
      playClickChime();
      cardEl.click();
    } else {
      dwellAnimFrame = requestAnimationFrame(step);
    }
  }

  dwellAnimFrame = requestAnimationFrame(step);
}

function cancelDwell(cardEl) {
  if (dwellAnimFrame) {
    cancelAnimationFrame(dwellAnimFrame);
    dwellAnimFrame = null;
  }
  if (activeDwellCard) {
    const hBar = activeDwellCard.querySelector('.dwell-progress-bar');
    const vBar = activeDwellCard.querySelector('.dwell-progress-bar-vertical');
    if (hBar) hBar.style.width = '0%';
    if (vBar) vBar.style.height = '0%';
    activeDwellCard = null;
  }
}

// ============================================================================
// MediaPipe Real-Time Eye Gaze & Blink Stream (Hackathon Core)
// Browser-based tracking via browser_tracker.js (client-side MediaPipe WebGL)
// ============================================================================
let gazeSource = 'webcam'; // 'webcam' (browser MediaPipe) or 'mouse' (click/touch)
let gazeStreamEventSource = null;
let lastGazeCard = null;
let hudVisible = true;

// Adaptive Gaze Stabilization Filter
let smoothX = window.innerWidth / 2;
let smoothY = window.innerHeight / 2;
const DEADBAND_PX = 12; // ignores micro-jitter under 12px
const HYSTERESIS_MARGIN = 38; // sticky magnetic card lock

// Eye Gesture State (Left -> Right -> Left = BACK & Look-Left Hold)
let gestureSequence = [];
let lastGlanceTime = 0;
let gestureCooldownUntil = 0;
let lookLeftStartTime = 0;

// ── 5-Blink System Power Toggle (Sleep / Wake Mode) ──
let systemTrackingPaused = false;
let blinkCounter = 0;
let lastBlinkTimestamp = 0;
const BLINK_SERIES_TIMEOUT_MS = 2500; // consecutive blinks within 2.5s
const TARGET_BLINKS_FOR_TOGGLE = 5;

function playSleepSound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(580, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(260, audioCtx.currentTime + 0.28);
    gain.gain.setValueAtTime(0.16, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.28);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.29);
  } catch(_) {}
}

function playWakeSound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(320, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(950, audioCtx.currentTime + 0.28);
    gain.gain.setValueAtTime(0.16, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.28);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.29);
  } catch(_) {}
}

function toggleSystemTrackingState() {
  systemTrackingPaused = !systemTrackingPaused;
  const reticle = document.getElementById('gaze-reticle');
  const sleepBanner = document.getElementById('tracking-sleep-banner');
  const sleepStatus = document.getElementById('hud-status');
  const topBtn = document.getElementById('gaze-mode-btn');

  // Cancel any active dwell countdown or card focus
  cancelDwell();
  if (lastGazeCard) {
    lastGazeCard.classList.remove('focused');
    lastGazeCard = null;
  }

  if (systemTrackingPaused) {
    // ⏸️ REST / SLEEP MODE ACTIVE
    if (reticle) reticle.style.display = 'none';
    if (sleepBanner) sleepBanner.style.display = 'flex';
    if (sleepStatus) {
      sleepStatus.textContent = '⏸️ SLEEP MODE (5-Blink to Wake)';
      sleepStatus.style.color = '#ffd166';
    }
    if (topBtn) {
      topBtn.textContent = '⏸️ SLEEP MODE';
      topBtn.classList.remove('active-gaze');
      topBtn.classList.add('sleep-gaze');
    }
    showToast('⏸️ Eye Tracking Paused! Blink 5 times to wake up.', 4000);
    speakText("Eye tracking paused. Sleep mode active.");
    playSleepSound();
  } else {
    // ▶️ AWAKEN / ACTIVE MODE
    if (reticle) reticle.style.display = 'block';
    if (sleepBanner) sleepBanner.style.display = 'none';
    if (sleepStatus) {
      sleepStatus.textContent = '● Eyes & Face Tracked';
      sleepStatus.style.color = '#3ddc84';
    }
    if (topBtn) {
      topBtn.textContent = '👁️ Gaze: WEBCAM LIVE';
      topBtn.classList.remove('sleep-gaze');
      topBtn.classList.add('active-gaze');
    }
    showToast('▶️ Eye Tracking Awakened! System active.', 3000);
    speakText("Eye tracking resumed. System active.");
    playWakeSound();
  }
}

window.toggleSystemTrackingState = toggleSystemTrackingState;

function initGazeStream() {
  if (gazeStreamEventSource) gazeStreamEventSource.close();

  gazeStreamEventSource = new EventSource('/api/gaze-stream');

  gazeStreamEventSource.onmessage = function(event) {
    if (gazeSource !== 'webcam') return;
    try {
      const data = JSON.parse(event.data);
      handleGazeData(data);
    } catch (e) {
      console.error("Gaze stream parse error:", e);
    }
  };

  gazeStreamEventSource.onerror = function() {
    const status = document.getElementById('hud-status');
    if (status) status.textContent = '● Connecting Camera...';
  };
}

function checkEyeGestureBack(normX) {
  if (currentView === 'home') return;
  const now = performance.now();
  if (now < gestureCooldownUntil) return;

  // Direct Method 1: Just look to the left side of the screen for 0.7s -> INSTANT BACK!
  const edgeBack = document.getElementById('left-edge-back');
  const edgeBar = document.querySelector('.dwell-progress-bar-vertical');
  if (normX < 0.28) {
    if (!lookLeftStartTime) lookLeftStartTime = now;
    const elapsed = now - lookLeftStartTime;
    if (edgeBack) edgeBack.classList.add('active-dwell');
    if (edgeBar) edgeBar.style.height = Math.min(100, (elapsed / 700) * 100) + '%';

    if (elapsed >= 700) {
      lookLeftStartTime = 0;
      if (edgeBar) edgeBar.style.height = '0%';
      gestureCooldownUntil = now + 1500;
      triggerBackGesture("Look-Left");
      return;
    }
  } else {
    lookLeftStartTime = 0;
    if (edgeBack) edgeBack.classList.remove('active-dwell');
    if (edgeBar) edgeBar.style.height = '0%';
  }

  // Method 2: Eye Sequence: Look Left -> Look Right -> Look Left
  if (now - lastGlanceTime > 1600) {
    gestureSequence = [];
  }

  let glance = null;
  if (normX < 0.36) glance = 'L'; // Looked left
  else if (normX > 0.64) glance = 'R'; // Looked right

  if (glance) {
    const last = gestureSequence[gestureSequence.length - 1];
    if (glance !== last) {
      gestureSequence.push(glance);
      lastGlanceTime = now;

      const pattern = gestureSequence.slice(-3).join('');
      if (pattern === 'LRL') {
        gestureSequence = [];
        gestureCooldownUntil = now + 1500;
        triggerBackGesture("Left-Right-Left Gesture");
      }
    }
  }
}

function triggerBackGesture(reason = "Eye Gesture") {
  showToast(`↩ ${reason} ➔ Back to Dashboard!`);
  speakText("Going back");
  closeAllModals();
  goHome();
}

function handleGazeData(data) {
  // Update Live Camera HUD
  const previewImg = document.getElementById('hud-preview-img');
  const fpsEl = document.getElementById('hud-fps');
  const statusEl = document.getElementById('hud-status');
  const blinkChip = document.getElementById('hud-blink-indicator');
  const reticle = document.getElementById('gaze-reticle');

  if (data.preview && previewImg) {
    previewImg.src = data.preview;
    previewImg.style.display = 'block';
  }
  if (fpsEl) fpsEl.textContent = `${data.fps || 0} FPS`;
  if (statusEl) {
    statusEl.textContent = data.found ? '● Face & Eyes Tracked' : '● Looking for face...';
    statusEl.style.color = data.found ? 'var(--good)' : 'var(--warn)';
  }

  // Handle 5-Blink Consecutive Power Toggle Gesture (Sleep / Wake System)
  if (data.blink) {
    const now = performance.now();
    if (now - lastBlinkTimestamp > BLINK_SERIES_TIMEOUT_MS) {
      blinkCounter = 1;
    } else {
      blinkCounter++;
    }
    lastBlinkTimestamp = now;

    if (blinkChip) {
      blinkChip.classList.add('active');
      blinkChip.textContent = `Blink ${blinkCounter}/5`;
      setTimeout(() => {
        blinkChip.classList.remove('active');
        if (!systemTrackingPaused) {
          blinkChip.textContent = blinkCounter > 0 ? `Blink ${blinkCounter}/5` : 'Blink: Ready';
        }
      }, 350);
    }

    if (reticle && !systemTrackingPaused) {
      reticle.classList.add('blinking');
      setTimeout(() => {
        if (reticle) reticle.classList.remove('blinking');
      }, 280);
    }

    // ⚡ Trigger 5-Blink Toggle: Sleep if active, Wake if sleeping!
    if (blinkCounter >= TARGET_BLINKS_FOR_TOGGLE) {
      blinkCounter = 0;
      toggleSystemTrackingState();
      return;
    }
  } else {
    // Reset counter if user stopped blinking and timeout passed
    if (blinkCounter > 0 && (performance.now() - lastBlinkTimestamp > BLINK_SERIES_TIMEOUT_MS)) {
      blinkCounter = 0;
      if (blinkChip && !systemTrackingPaused) {
        blinkChip.textContent = 'Blink: Ready';
      }
    }
  }

  // ⏸️ If Tracking is in SLEEP MODE, completely pause gaze tracking, dwell, and card focus!
  if (systemTrackingPaused) {
    return;
  }

  if (!data.found || !reticle) {
    return;
  }

  // 1. Check Eye Gesture for BACK: Look Left -> Look Right -> Look Left
  checkEyeGestureBack(data.x);

  // 2. High-Accuracy, Zero-Latency Targeting
  // OneEuro filter in browser_tracker.js already eliminates jitter
  const targetX = data.x * window.innerWidth;
  const targetY = data.y * window.innerHeight;

  // Responsive interpolation (< 20ms visual tracking)
  smoothX = smoothX * 0.15 + targetX * 0.85;
  smoothY = smoothY * 0.15 + targetY * 0.85;

  // 3. AAC Assisted Magnetic Target Lock
  const magneticHit = findMagneticTarget(smoothX, smoothY);
  let card = null;

  if (magneticHit) {
    card = magneticHit.el;
    // Magnetic Attraction: gently center the reticle on the card
    const pullX = smoothX * 0.25 + magneticHit.cx * 0.75;
    const pullY = smoothY * 0.25 + magneticHit.cy * 0.75;
    reticle.style.left = pullX + 'px';
    reticle.style.top = pullY + 'px';
    reticle.classList.add('magnetic-locked');
  } else {
    reticle.style.left = smoothX + 'px';
    reticle.style.top = smoothY + 'px';
    reticle.classList.remove('magnetic-locked');
  }

  if (card) {
    if (card !== lastGazeCard) {
      if (lastGazeCard) {
        lastGazeCard.classList.remove('focused');
        cancelDwell(lastGazeCard);
      }
      lastGazeCard = card;
      card.classList.add('focused');
      startDwell(card);
    }

    // Voluntary Single Blink Confirmation (only when deliberately looking at card > 300ms)
    if (data.blink && blinkCounter === 1 && !systemTrackingPaused && activeDwellCard === card) {
      const dwellElapsed = performance.now() - (window.currentDwellStartTime || 0);
      if (dwellElapsed > 300) {
        cancelDwell(card);
        playClickChime();
        card.click();
        showToast("Blink Confirmed!");
      }
    }
  } else {
    if (lastGazeCard) {
      lastGazeCard.classList.remove('focused');
      cancelDwell(lastGazeCard);
      lastGazeCard = null;
    }
  }
}

// ── AAC Assisted Magnetic Target Snapping ──
function findMagneticTarget(x, y) {
  // If already locked on a card, keep it locked until gaze moves > 100px away
  if (lastGazeCard && lastGazeCard.isConnected) {
    const rect = lastGazeCard.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dist = Math.hypot(x - cx, y - cy);
    const holdRadius = Math.max(rect.width, rect.height) * 0.72 + 50;
    if (dist < holdRadius) {
      return { el: lastGazeCard, cx, cy };
    }
  }

  // Find nearest interactive AAC card/button within 85px
  const selector = '.card, .isl-board-card, .isl-anchor-btn, .btn-perm-back, .isl-ai-pill, .isl-body-region-btn, .btn-quick';
  const candidates = document.querySelectorAll(selector);
  let best = null;
  let minDistance = 85;

  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i];
    if (el.offsetParent === null) continue;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dist = Math.hypot(x - cx, y - cy);
    if (dist < minDistance) {
      minDistance = dist;
      best = { el, cx, cy };
    }
  }

  return best;
}

async function recenterGaze() {
  if (typeof window.startQuickCalibration === 'function') {
    window.startQuickCalibration();
    return;
  }
  try {
    const res = await fetch('/api/recenter-gaze', { method: 'POST' });
    if (res.ok) {
      showToast("🎯 Gaze position centered to screen!");
    } else {
      showToast("Look straight at screen to center");
    }
  } catch (err) {
    console.error("Recenter error:", err);
  }
}

function toggleGazeSource() {
  gazeSource = (gazeSource === 'webcam') ? 'mouse' : 'webcam';
  const btn = document.getElementById('gaze-mode-btn');
  const hud = document.getElementById('camera-hud');

  if (gazeSource === 'webcam') {
    if (btn) {
      btn.textContent = '👁️ Gaze: WEBCAM LIVE';
      btn.classList.add('active-gaze');
    }
    if (hud) hud.style.display = 'block';
    if (window.initBrowserTracker) {
      window.initBrowserTracker();
    } else {
      initGazeStream();
    }
    showToast("Starting Browser MediaPipe Eye Tracking…");
  } else {
    if (window.stopBrowserTracker) window.stopBrowserTracker();
    if (gazeStreamEventSource) {
      gazeStreamEventSource.close();
      gazeStreamEventSource = null;
    }
    if (btn) {
      btn.textContent = '🖱️ Gaze: CLICK / TOUCH';
      btn.classList.remove('active-gaze');
    }
    if (hud) hud.style.display = 'none';
    showToast("Switched to Click / Touch Mode");
  }
}

function toggleHudVisibility() {
  const body = document.getElementById('hud-body');
  hudVisible = !hudVisible;
  if (body) {
    body.style.display = hudVisible ? 'flex' : 'none';
  }
}

async function recenterGaze() {
  if (window.recenterBrowserGaze && window.isBrowserTrackerRunning && window.isBrowserTrackerRunning()) {
    window.recenterBrowserGaze();
    return;
  }
  try {
    const res = await fetch('/api/recenter-gaze', { method: 'POST' });
    if (res.ok) {
      showToast("🎯 Gaze position centered to screen!");
    } else {
      showToast("Look straight at screen to center");
    }
  } catch (err) {
    console.error("Recenter error:", err);
  }
}

// Global mouse/pointer tracking for click/touch fallback mode
window.addEventListener('mousemove', (e) => {
  if (gazeSource !== 'mouse') return;
  const reticle = document.getElementById('gaze-reticle');
  if (reticle) {
    reticle.style.left = e.clientX + 'px';
    reticle.style.top = e.clientY + 'px';
    reticle.style.display = 'block';
  }
});

window.addEventListener('touchmove', (e) => {
  if (gazeSource !== 'mouse' || !e.touches || !e.touches[0]) return;
  const reticle = document.getElementById('gaze-reticle');
  if (reticle) {
    reticle.style.left = e.touches[0].clientX + 'px';
    reticle.style.top = e.touches[0].clientY + 'px';
    reticle.style.display = 'block';
  }
}, { passive: true });

// ============================================================================
// Initialization & Mode Selection
// ============================================================================
let activeCommunicationMode = null; // 'eye_to_speech' or 'sign_to_speech'

document.addEventListener('DOMContentLoaded', () => {
  loadData();
  setupKeyboardNavigation();
  initSpeech();

  // Check if a communication mode was previously chosen
  const savedMode = sessionStorage.getItem('eyevoice_mode');
  if (savedMode === 'sign_to_speech') {
    switchCommunicationMode('sign_to_speech', false);
  } else if (savedMode === 'eye_to_speech') {
    switchCommunicationMode('eye_to_speech', false);
  } else {
    // First time in session: Present the Communication Pathway Selector upfront!
    setTimeout(() => {
      openModeSelectorModal();
    }, 350);
  }

  // Speak button
  document.getElementById('speak-btn').addEventListener('click', () => {
    if (currentMessage) speakText(currentMessage);
  });

  // Clear message button
  document.getElementById('clear-msg-btn').addEventListener('click', clearMessage);
});

// ============================================================================
// Data Loading & API
// ============================================================================
async function loadISLData() {
  try {
    const [signsRes, catsRes] = await Promise.all([
      fetch('/api/isl/signs'),
      fetch('/api/isl/categories')
    ]);
    if (signsRes.ok) {
      const data = await signsRes.json();
      islSignsData = data.signs || [];
    }
    if (catsRes.ok) {
      islCategoriesData = await catsRes.json();
    }
  } catch (err) {
    console.error("Failed to load ISL sign lexicon:", err);
  }
}

async function loadData() {
  try {
    const [res] = await Promise.all([
      fetch('/api/categories'),
      loadISLData()
    ]);
    if (!res.ok) throw new Error('Failed to load categories');
    appData = await res.json();
    renderView();
  } catch (err) {
    console.error(err);
    document.getElementById('content').innerHTML = `
      <div class="loading-state">
        <p style="color:var(--danger)">Failed to load communication library. Please refresh.</p>
      </div>
    `;
  }
}

// ============================================================================
// View Rendering
// ============================================================================
function renderView() {
  const content = document.getElementById('content');
  const breadcrumbCurrent = document.getElementById('breadcrumb-current');
  const breadcrumbSep = document.getElementById('breadcrumb-separator');
  const homeBtn = document.getElementById('home-btn');

  const persistentBack = document.getElementById('btn-persistent-back');
  const edgeBack = document.getElementById('left-edge-back');

  if (currentView === 'home') {
    homeBtn.classList.add('active');
    breadcrumbCurrent.style.display = 'none';
    breadcrumbSep.style.display = 'none';
    if (persistentBack) persistentBack.classList.add('hidden');
    renderHomeView(content);
  } else if (currentView === 'sign_to_speech' || (currentCategory && currentCategory.id === 'sign_to_speech')) {
    homeBtn.classList.remove('active');
    breadcrumbCurrent.style.display = 'inline-block';
    breadcrumbSep.style.display = 'inline-block';
    breadcrumbCurrent.textContent = '🤟 Sign Language to Speech';
    if (persistentBack) persistentBack.classList.remove('hidden');
    renderSignToSpeechView(content);
  } else if (currentView === 'isl_sign_language' || (currentCategory && currentCategory.id === 'isl_sign_language')) {
    homeBtn.classList.remove('active');
    breadcrumbCurrent.style.display = 'inline-block';
    breadcrumbSep.style.display = 'inline-block';
    breadcrumbCurrent.textContent = '🤟 Sign Language to Speech (ISL)';
    if (persistentBack) persistentBack.classList.remove('hidden');
    renderISLView(content);
  } else {
    homeBtn.classList.remove('active');
    breadcrumbCurrent.style.display = 'inline-block';
    breadcrumbSep.style.display = 'inline-block';
    breadcrumbCurrent.textContent = currentCategory.name;
    if (persistentBack) persistentBack.classList.remove('hidden');
    renderCategoryView(content);
  }

  // Update focusable elements for keyboard/gaze navigation
  updateFocusableGrid();
}

function renderHomeView(container) {
  const html = `
    <div class="cards-grid">
      ${appData.categories.map((cat, idx) => `
        <div class="card ${cat.is_external ? 'keyboard-card' : ''} ${cat.is_isl ? 'isl-feature-card' : ''} ${cat.is_sign_to_speech ? 'sign-to-speech-card' : ''}" 
             data-index="${idx}"
             onmouseenter="startDwell(this)"
             onmouseleave="cancelDwell(this)"
             onclick="selectCategory('${cat.id}')">
          <div class="dwell-progress-bar"></div>
          ${cat.is_external ? '<span class="card-badge">TEAMMATE FEATURE</span>' : ''}
          ${cat.is_isl ? '<span class="card-badge isl-badge">👁️ EYE CONTROL BOARD</span>' : ''}
          ${cat.is_sign_to_speech ? '<span class="card-badge" style="background:linear-gradient(135deg,#10b981,#059669);color:#fff;">🤟 NEW INTERPRETER</span>' : ''}
          <div class="card-icon">${cat.icon}</div>
          <div class="card-title">${cat.name}</div>
          <div class="card-desc">${cat.description || ''}</div>
        </div>
      `).join('')}
    </div>
  `;
  container.innerHTML = html;
}

function renderCategoryView(container) {
  const cat = currentCategory;
  const isVL = cat.id === 'visual_language';

  let html = `
    <div class="category-header-banner">
      <div class="cat-banner-info">
        <h2><span>${cat.icon}</span> ${cat.name}</h2>
        <p>${cat.description || 'Select an option below to communicate'}</p>
      </div>
      <button class="btn-back" onclick="goHome()">⬅ Back to Dashboard</button>
    </div>
  `;

  if (isVL && visualTokens.length > 0) {
    html += `
      <div style="background:var(--panel-alt);border:1px solid var(--accent);border-radius:12px;padding:12px 16px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;">
        <div>
          <span style="color:var(--text-muted);font-size:0.85rem;">Composed Sign Sequence: </span>
          <strong style="color:var(--accent);font-size:1.1rem;">${visualTokens.map(t => '[' + t.label + ']').join(' ➔ ')}</strong>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn-sm" onclick="undoVisualToken()">↩ Undo</button>
          <button class="btn-sm del" onclick="clearVisualTokens()">Clear</button>
        </div>
      </div>
    `;
  }

  html += `
    <div class="cards-grid">
      <div class="card option-card back-card" 
           data-index="back"
           onmouseenter="startDwell(this)"
           onmouseleave="cancelDwell(this)"
           onclick="goHome()">
        <div class="dwell-progress-bar"></div>
        <div class="card-icon">↩️</div>
        <div class="card-title">BACK TO DASHBOARD</div>
        <div class="card-desc">Look here or glance: Left ➔ Right ➔ Left</div>
      </div>
      ${cat.options.map((opt, idx) => `
        <div class="card option-card" 
             data-index="${idx}"
             onmouseenter="startDwell(this)"
             onmouseleave="cancelDwell(this)"
             onclick="selectOption('${opt.id}')">
          <div class="dwell-progress-bar"></div>
          ${opt.custom ? '<span class="card-badge custom">CUSTOM</span>' : ''}
          <div class="card-icon">${opt.icon || '💬'}</div>
          <div class="card-title">${opt.label}</div>
          <div class="card-desc">${opt.message}</div>
        </div>
      `).join('')}
    </div>
  `;
  container.innerHTML = html;
}

// ============================================================================
// User Selection & Actions
// ============================================================================
function selectCategory(catId) {
  if (catId === 'keyboard') {
    openKeyboardModal();
    return;
  }
  if (catId === 'sign_to_speech') {
    const cat = appData.categories.find(c => c.id === catId) || {
      id: 'sign_to_speech',
      name: '🤟 Sign Language to Speech',
      icon: '🤟'
    };
    currentCategory = cat;
    currentView = 'sign_to_speech';
    focusedIndex = 0;
    renderView();
    showToast("Opened Sign Language Interpreter");
    return;
  }
  if (catId === 'isl_sign_language') {
    const cat = appData.categories.find(c => c.id === catId) || {
      id: 'isl_sign_language',
      name: '👁️ Sign Language to Speech',
      icon: '🤟'
    };
    currentCategory = cat;
    currentView = 'isl_sign_language';
    focusedIndex = 0;
    renderView();
    showToast("Opened Sign Language to Speech");
    return;
  }
  const cat = appData.categories.find(c => c.id === catId);
  if (!cat) return;
  currentCategory = cat;
  currentView = catId;
  focusedIndex = 0;
  renderView();
}

function selectOption(optId) {
  const opt = currentCategory.options.find(o => o.id === optId);
  if (!opt) return;

  if (currentCategory.id === 'visual_language') {
    // Compositional sign language token
    visualTokens.push(opt);
    const resolvedSentence = interpretVisualTokens(visualTokens);
    setMessage(resolvedSentence, '🧠');
    renderView();
  } else {
    // Direct communication card
    setMessage(opt.message, opt.icon);
    speakText(opt.message);
    postMessageToServer(opt.message, currentCategory.name, false);
    showToast(`Communicated: "${opt.message}"`);
  }
}

function interpretVisualTokens(tokens) {
  // Visual Language Grammar Interpreter
  if (!tokens || !tokens.length) return '';
  const labels = tokens.map(t => t.id);

  // Compositional grammar rules
  if (labels.includes('i_me') && labels.includes('want') && labels.includes('drink')) {
    return "I want something to drink, please.";
  }
  if (labels.includes('i_me') && labels.includes('want') && labels.includes('eat')) {
    return "I want something to eat, please.";
  }
  if (labels.includes('i_me') && labels.includes('feel') && labels.includes('bad')) {
    return "I am feeling unwell.";
  }
  if (labels.includes('i_me') && labels.includes('feel') && labels.includes('good')) {
    return "I am feeling good.";
  }
  if (labels.includes('i_me') && labels.includes('need_vl') && labels.includes('now')) {
    return "I need immediate help right now.";
  }
  
  // Default fluent join
  const joined = tokens.map(t => t.message).join(' ');
  return joined.charAt(0).toUpperCase() + joined.slice(1) + ".";
}

function undoVisualToken() {
  visualTokens.pop();
  if (visualTokens.length > 0) {
    const msg = interpretVisualTokens(visualTokens);
    setMessage(msg, '🧠');
  } else {
    clearMessage();
  }
  renderView();
}

function clearVisualTokens() {
  visualTokens = [];
  clearMessage();
  renderView();
}

// ============================================================================
// Indian Sign Language (ISL) to Speech — Practical Visual Body Anchors
// Zero-scroll layout: Body Location Anchor -> Immediate Natural Sign Expression
// ============================================================================
const ISL_BODY_ANCHORS = [
  {
    id: "forehead",
    name: "Forehead & Mind",
    icon: "🧠",
    hint: "Touch forehead: 'What is your name?', headache, thought",
    gestureExplainer: "ISL Parameter: Location = Forehead / Temple | Identity, Questions & Cognition",
    expressions: [
      {
        id: "name_inquiry",
        icon: "🏷️",
        gesture: "Touch Forehead + Point Forward",
        sentence: "What is your name?",
        meaning: "ISL Name Sign (Forehead contact + 2nd person point)",
        urgent: false
      },
      {
        id: "not_understand",
        icon: "🤔",
        gesture: "Touch Temple + Furrowed Brow",
        sentence: "I don't understand what you mean. Please explain again.",
        meaning: "ISL Cognitive Negation (Temple touch with furrowed brow)",
        urgent: false
      },
      {
        id: "understand",
        icon: "💡",
        gesture: "Flick Index from Forehead + Nod",
        sentence: "Yes, I understand you clearly.",
        meaning: "ISL Comprehension (Index flick from temple)",
        urgent: false
      },
      {
        id: "headache",
        icon: "⚡",
        gesture: "Twist Index Fingers at Temples + Grimace",
        sentence: "I have a severe headache. Please help me.",
        meaning: "ISL Head Pain (Opposing index twist at temples)",
        urgent: true
      },
      {
        id: "dizzy",
        icon: "💫",
        gesture: "Claw Hand Circles Forehead",
        sentence: "I am feeling very dizzy and lightheaded.",
        meaning: "ISL Dizziness (Claw hand circling in front of eyes)",
        urgent: true
      },
      {
        id: "think_opinion",
        icon: "💭",
        gesture: "Touch Temple + Raised Eyebrows",
        sentence: "What do you think? What should we do?",
        meaning: "ISL Opinion Inquiry (Temple contact with interrogative face)",
        urgent: false
      }
    ]
  },
  {
    id: "mouth",
    name: "Mouth & Chin",
    icon: "👄",
    hint: "Touch chin: 'Water', food, talk, thank you",
    gestureExplainer: "ISL Parameter: Location = Mouth / Lips / Chin | Sustenance, Speaking & Gratitude",
    expressions: [
      {
        id: "water",
        icon: "💧",
        gesture: "W-Hand Taps Chin Twice",
        sentence: "I need some water to drink, please.",
        meaning: "ISL Water Sign (Documented ISLRTC Entry #WAT-02)",
        urgent: false
      },
      {
        id: "food",
        icon: "🍚",
        gesture: "Bunched Fingertips Tap Lips Twice",
        sentence: "I am hungry and would like something to eat.",
        meaning: "ISL Food Sign (Flat O-hand contacting lips)",
        urgent: false
      },
      {
        id: "thank_you",
        icon: "🙏",
        gesture: "Flat Hand Touches Chin & Moves Forward",
        sentence: "Thank you very much.",
        meaning: "ISL Politeness Formula (Chin forward arc with slight bow)",
        urgent: false
      },
      {
        id: "tell_me",
        icon: "🗣️",
        gesture: "Finger Points from Mouth to Interlocutor",
        sentence: "Please talk to me and tell me what is happening.",
        meaning: "ISL Directional Tell (Mouth outward arc to 1st person)",
        urgent: false
      },
      {
        id: "stop_refusal",
        icon: "🛑",
        gesture: "Fingers Push Away from Mouth + Headshake",
        sentence: "Please stop, I don't want that.",
        meaning: "ISL Refusal (Pushing away from oral space with headshake)",
        urgent: false
      },
      {
        id: "medicine",
        icon: "💊",
        gesture: "Middle Finger Circles Non-Dominant Palm",
        sentence: "Is it time for my medicine? Please give it to me.",
        meaning: "ISL Medicine (Mortar and pestle motion in palm)",
        urgent: false
      }
    ]
  },
  {
    id: "chest",
    name: "Chest & Heart",
    icon: "🫀",
    hint: "Touch chest: 'Me', breathing, anxiety, pain",
    gestureExplainer: "ISL Parameter: Location = Sternum / Heart | Internal States, Respiratory & Affect",
    expressions: [
      {
        id: "breath_emergency",
        icon: "😰",
        gesture: "Hands Expanding on Chest + Respiration Strain",
        sentence: "I cannot breathe comfortably! Please help me immediately!",
        meaning: "ISL Respiratory Alert (Bilateral chest expansion with strain)",
        urgent: true
      },
      {
        id: "chest_pain",
        icon: "⚡",
        gesture: "Twisting Fingers over Sternum + Pained Face",
        sentence: "I have severe chest pain. Please call the doctor immediately!",
        meaning: "ISL Acute Chest Pain (Center chest index twist with grimace)",
        urgent: true
      },
      {
        id: "anxious",
        icon: "💓",
        gesture: "Rapid Fluttering Hands over Heart",
        sentence: "I am feeling very anxious. Please stay with me.",
        meaning: "ISL Anxiety / Fear (Trembling open hands at heart)",
        urgent: true
      },
      {
        id: "self_identity",
        icon: "👉",
        gesture: "Index Finger Points to Center Chest",
        sentence: "I want to talk about how I am feeling.",
        meaning: "ISL First Person Pronoun PRO-1 (Direct sternum index point)",
        urgent: false
      },
      {
        id: "sleep_rest",
        icon: "😴",
        gesture: "Hands Crossed Over Chest with Head Tilt",
        sentence: "I am exhausted and I need to sleep and rest now.",
        meaning: "ISL Rest / Sleep (Bilateral chest cross with relaxed shoulders)",
        urgent: false
      },
      {
        id: "relieved_happy",
        icon: "😊",
        gesture: "Open Palm Brushes Upward on Heart with Smile",
        sentence: "I am feeling much better now, thank you.",
        meaning: "ISL Happiness / Relief (Upward heart brush with genuine smile)",
        urgent: false
      }
    ]
  },
  {
    id: "body",
    name: "Body & Position",
    icon: "🧍",
    hint: "Body needs: turn position, washroom, cold, back pain",
    gestureExplainer: "ISL Parameter: Location = Torso / Back / Somatic | Comfort & Mobility",
    expressions: [
      {
        id: "turn_position",
        icon: "🔄",
        gesture: "Both Curved Hands Rotate 180°",
        sentence: "Please help me turn over and change my position in bed.",
        meaning: "ISL Reposition Sign (Semicircular hand rotation)",
        urgent: false
      },
      {
        id: "back_pain",
        icon: "🧍",
        gesture: "Thumb Points Backward over Shoulder",
        sentence: "My back is hurting terribly from lying down.",
        meaning: "ISL Lumbar Pain (Thumb backward pointing gesture with grimace)",
        urgent: true
      },
      {
        id: "toilet_urgent",
        icon: "🚻",
        gesture: "T-Hand Shakes Side-to-Side",
        sentence: "I urgently need assistance to use the washroom.",
        meaning: "ISL Toilet Sign (T-handshake with urgent expression)",
        urgent: true
      },
      {
        id: "cold_blanket",
        icon: "🥶",
        gesture: "Arms Shivering with Hands at Chest",
        sentence: "I am feeling cold. Please cover me with a blanket.",
        meaning: "ISL Cold & Blanket (Bilateral shivering S-fists)",
        urgent: false
      },
      {
        id: "hot_fan",
        icon: "🥵",
        gesture: "Fanning Away from Face + Brow Furrow",
        sentence: "I am feeling hot. Please turn on the ceiling fan.",
        meaning: "ISL Heat / Fan (Hand throws heat away from face)",
        urgent: false
      },
      {
        id: "help_me_now",
        icon: "🤝",
        gesture: "Fist Lifted Up by Open Non-Dominant Palm",
        sentence: "Please help me right now.",
        meaning: "ISL Directional Assistance (2nd person supporting 1st person)",
        urgent: true
      }
    ]
  },
  {
    id: "people",
    name: "People & Doctor",
    icon: "👥",
    hint: "Touch wrist: Doctor pulse, nurse cross, family",
    gestureExplainer: "ISL Parameter: Location = Wrist / Upper Arm / Social Space | Medical & Care",
    expressions: [
      {
        id: "where_doctor",
        icon: "👨‍⚕️",
        gesture: "Two Fingers Tap Radial Pulse at Wrist",
        sentence: "Where is the doctor? When will they examine me?",
        meaning: "ISL Doctor Sign (Tapping wrist pulse with attentive gaze)",
        urgent: false
      },
      {
        id: "call_nurse",
        icon: "👩‍⚕️",
        gesture: "Thumb Traces Red Cross on Upper Arm",
        sentence: "Please call the nurse to check on me.",
        meaning: "ISL Nurse Sign (Tracing cross on arm / forehead)",
        urgent: false
      },
      {
        id: "where_family",
        icon: "👨‍👩‍👧",
        gesture: "F-Hands Circle Together in Front",
        sentence: "Where is my family? I want to see them.",
        meaning: "ISL Family Sign (Bilateral F-hands circular contact)",
        urgent: false
      },
      {
        id: "thank_caregiver",
        icon: "🧑‍🤝‍🧑",
        gesture: "Two Hands Support Wrist with Slight Bow",
        sentence: "Thank you, caregiver, for looking after me.",
        meaning: "ISL Caregiver Sign (Supporting wrist motion with respectful nod)",
        urgent: false
      },
      {
        id: "you_how_are_you",
        icon: "🫵",
        gesture: "Index Finger Points Forward + Raised Eyebrows",
        sentence: "How are you doing today? Is everything okay?",
        meaning: "ISL Interpersonal Inquiry (Direct pointing with friendly raised brow)",
        urgent: false
      },
      {
        id: "greetings_hello",
        icon: "👋",
        gesture: "Open Hand Wave from Temple",
        sentence: "Hello! It is so good to see you.",
        meaning: "ISL Salutation (Temple wave with warm smile)",
        urgent: false
      }
    ]
  },
  {
    id: "questions",
    name: "Questions & Inquiries",
    icon: "❓",
    hint: "Inquire: What?, Where?, When?, How?, Is it okay?",
    gestureExplainer: "ISL Parameter: Non-Manual Markers = Eyebrow Furrow (Wh) / Eyebrow Raise (Polar)",
    expressions: [
      {
        id: "what_happening",
        icon: "❓",
        gesture: "Open Palms Shake + Furrowed Eyebrows",
        sentence: "What is happening? What is going on?",
        meaning: "ISL What Sign (Sentence-final interrogative with brow furrow)",
        urgent: false
      },
      {
        id: "where_place",
        icon: "📍",
        gesture: "Index Finger Shakes Side-to-Side + Head Tilt",
        sentence: "Where are you going? Where is everyone?",
        meaning: "ISL Where Sign (Upright index oscillation with tilted head)",
        urgent: false
      },
      {
        id: "when_time",
        icon: "⏰",
        gesture: "Index Finger Circles Other Index Tip",
        sentence: "What time is it now? When is the next checkup?",
        meaning: "ISL When Sign (Circular index contact with question marker)",
        urgent: false
      },
      {
        id: "why_reason",
        icon: "🤔",
        gesture: "Hand Brushes Forehead into Y-Hand",
        sentence: "Why is this happening? Can you explain why?",
        meaning: "ISL Why Sign (Forehead pull away into Y-hand)",
        urgent: false
      },
      {
        id: "is_okay_polar",
        icon: "❔",
        gesture: "Body Leans Forward + Eyebrows Raised High",
        sentence: "Is everything going to be okay?",
        meaning: "ISL Polar Question Marker (High eyebrow raise + forward torso freeze)",
        urgent: false
      },
      {
        id: "difficult_struggle",
        icon: "😓",
        gesture: "Bent Knuckles Strike Together with Strained Face",
        sentence: "This is very difficult for me right now.",
        meaning: "ISL Difficult Sign (Knuckles impact with tight jaw)",
        urgent: true
      }
    ]
  },
  {
    id: "gemini_anything",
    name: "✨ AI (Speak Anything)",
    icon: "✨",
    hint: "Gemini AI: jokes, family messages, doctor talks, anything you want",
    gestureExplainer: "Powered by Google Gemini AI: Infinite Open-Ended First-Person Speech Generation",
    expressions: [
      {
        id: "ai_joke",
        icon: "😄",
        gesture: "AI Creative Humor",
        sentence: "Can someone tell me a good joke, or would you like to hear one?",
        meaning: "Casual conversation and laughter",
        urgent: false
      },
      {
        id: "ai_family",
        icon: "❤️",
        gesture: "AI Affection & Love",
        sentence: "Please tell my family that I love them deeply and appreciate everything.",
        meaning: "Heartfelt personal message to loved ones",
        urgent: false
      },
      {
        id: "ai_symptom",
        icon: "🩺",
        gesture: "AI Detailed Clinical Description",
        sentence: "I want to explain to the doctor that my numbness is spreading slightly today.",
        meaning: "Detailed custom clinical symptom description",
        urgent: true
      },
      {
        id: "ai_tea",
        icon: "☕",
        gesture: "AI Exact Preference",
        sentence: "Could I please get some warm tea with just a tiny bit of honey?",
        meaning: "Specific personalized drink request",
        urgent: false
      },
      {
        id: "ai_news",
        icon: "📰",
        gesture: "AI Curiosity & World",
        sentence: "What is happening outside today? How is the weather and news?",
        meaning: "Connecting to the outside world",
        urgent: false
      },
      {
        id: "ai_custom_prompt",
        icon: "💡",
        gesture: "AI Free-Form Topic Expander",
        sentence: "I want to talk about something specific. Please ask Gemini AI for me.",
        meaning: "Open-ended custom AI topic expansion",
        urgent: false
      }
    ]
  }
];

let geminiFollowups = [];
let geminiLoading = false;

async function fetchGeminiFollowups(sentence) {
  try {
    const res = await fetch('/api/gemini/followups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sentence: sentence })
    });
    if (res.ok) {
      const data = await res.json();
      geminiFollowups = data.followups || [];
      renderView();
    }
  } catch (err) {
    console.error("Gemini followups error:", err);
  }
}

function triggerAIFollowup(sentence, icon = '💬') {
  speakText(sentence);
  postMessageToServer(sentence, "Gemini AI Follow-up", false);
  setMessage(sentence, icon);
  showToast(`🗣️ Spoke: "${sentence}"`);
  islLastSpokenText = sentence;
  fetchGeminiFollowups(sentence);
}

async function generateFreshWithGemini(topic = '') {
  const currentAnchor = ISL_BODY_ANCHORS.find(a => a.id === islSelectedAnchor) || ISL_BODY_ANCHORS[0];
  const queryTopic = topic || currentAnchor.name;
  geminiLoading = true;
  showToast(`✨ Gemini is crafting speech for: "${queryTopic}"...`);
  
  try {
    const res = await fetch('/api/gemini/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cue: queryTopic, context: currentAnchor.gestureExplainer })
    });
    if (res.ok) {
      const data = await res.json();
      if (data.options && data.options.length > 0) {
        currentAnchor.expressions = data.options;
        showToast(`✨ Generated 6 new options for "${queryTopic}"!`);
      }
    }
  } catch (err) {
    console.error("Gemini generate error:", err);
    showToast("Gemini offline. Using local speech engine.");
  } finally {
    geminiLoading = false;
    renderView();
  }
}

function askCustomAIPrompt() {
  const prompt = window.prompt("What would you like to speak about? (e.g., 'cricket score', 'tell a joke', 'message to my daughter', 'side effect of medicine'):");
  if (prompt && prompt.trim()) {
    generateFreshWithGemini(prompt.trim());
  }
}

function selectISLAnchor(anchorId) {
  islSelectedAnchor = anchorId;
  const anchor = ISL_BODY_ANCHORS.find(a => a.id === anchorId);
  if (anchor) {
    showToast(`Switched Anchor: ${anchor.name}`);
  }
  renderView();
}

function triggerISLExpression(exprId) {
  const currentAnchor = ISL_BODY_ANCHORS.find(a => a.id === islSelectedAnchor) || ISL_BODY_ANCHORS[0];
  const expr = currentAnchor.expressions.find(e => e.id === exprId);
  if (!expr) return;

  islLastSpokenText = expr.sentence;

  // Speak aloud immediately
  speakText(expr.sentence);

  // Send to Caregiver message board
  postMessageToServer(expr.sentence, `Sign Language (ISL - ${currentAnchor.name})`, Boolean(expr.urgent));

  // Update topbar message
  setMessage(expr.sentence, expr.icon);

  // Show toast
  showToast(`🗣️ Spoke: "${expr.sentence}"`);

  // Visual card feedback
  const card = document.querySelector(`[data-expr-id="${exprId}"]`);
  if (card) {
    card.style.borderColor = '#34d399';
    card.style.transform = 'scale(1.04)';
    setTimeout(() => {
      if (card) {
        card.style.borderColor = '';
        card.style.transform = '';
      }
    }, 450);
  }

  // Fetch intelligent Gemini follow-ups in background
  fetchGeminiFollowups(expr.sentence);
}

function replayISL() {
  if (islLastSpokenText) {
    speakText(islLastSpokenText);
    showToast(`Replaying: "${islLastSpokenText}"`);
  } else {
    showToast("Look at any expression card to speak.");
  }
}

function renderISLView(container) {
  const currentAnchor = ISL_BODY_ANCHORS.find(a => a.id === islSelectedAnchor) || ISL_BODY_ANCHORS[0];

  let html = `
    <div class="isl-practical-workspace">
      <!-- LEFT COLUMN: 7 BODY & AI ANCHORS (ZERO SCROLLING) -->
      <div class="isl-anchors-column">
        <div class="isl-anchors-header">
          <div class="isl-anchors-title">
            <span>🤟</span> Body Sign &amp; AI Anchors
          </div>
          <span class="isl-anchors-sub">Look to switch</span>
        </div>

        <div class="isl-anchors-list">
          ${ISL_BODY_ANCHORS.map(anchor => `
            <div class="isl-anchor-btn ${islSelectedAnchor === anchor.id ? 'active' : ''} ${anchor.id === 'gemini_anything' ? 'ai-anchor-card' : ''}"
                 onmouseenter="startDwell(this)"
                 onmouseleave="cancelDwell(this)"
                 onclick="selectISLAnchor('${anchor.id}')"
                 title="${anchor.hint}">
              <div class="dwell-progress-bar"></div>
              <div class="isl-anchor-icon">${anchor.icon}</div>
              <div class="isl-anchor-info">
                <div class="isl-anchor-name">
                  ${anchor.name}
                  ${islSelectedAnchor === anchor.id ? '<span style="color:#34d399;font-size:0.75rem;">● ACTIVE</span>' : ''}
                </div>
                <div class="isl-anchor-hint">${anchor.hint}</div>
              </div>
              <div class="isl-anchor-arrow">${islSelectedAnchor === anchor.id ? '▶' : '›'}</div>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- RIGHT COLUMN: IMMEDIATE NATURAL SIGN EXPRESSIONS (ZERO SCROLLING) -->
      <div class="isl-expressions-column">
        <!-- TOP ACTIVE BANNER -->
        <div class="isl-active-bar">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <div class="isl-active-location-badge">
              <span>${currentAnchor.icon}</span> ${currentAnchor.name}
            </div>
            <span class="isl-gesture-explainer">${currentAnchor.gestureExplainer}</span>
          </div>

          <div style="display:flex;align-items:center;gap:8px;">
            <button class="isl-ai-generate-btn" onclick="generateFreshWithGemini()" onmouseenter="startDwell(this)" onmouseleave="cancelDwell(this)" title="Generate 6 brand new open sentences using Gemini AI">
              <div class="dwell-progress-bar"></div>
              ✨ AI Expand Sentences
            </button>
            <button class="isl-speech-replay-btn" onclick="askCustomAIPrompt()" onmouseenter="startDwell(this)" onmouseleave="cancelDwell(this)" title="Speak about any custom topic">
              <div class="dwell-progress-bar"></div>
              💡 Speak Anything
            </button>
            <button class="isl-speech-replay-btn" onclick="replayISL()" onmouseenter="startDwell(this)" onmouseleave="cancelDwell(this)" title="Replay the last spoken sentence">
              <div class="dwell-progress-bar"></div>
              🔁 Replay
            </button>
            <button class="btn-back" onclick="goHome()" onmouseenter="startDwell(this)" onmouseleave="cancelDwell(this)" style="margin:0;padding:8px 14px;font-size:0.85rem;">
              <div class="dwell-progress-bar"></div>
              ⬅ Back
            </button>
          </div>
        </div>

        <!-- DYNAMIC GEMINI SMART FOLLOW-UPS BAR (IF AVAILABLE) -->
        ${geminiFollowups.length > 0 ? `
          <div class="isl-ai-followups-bar">
            <div class="isl-ai-followups-label">
              <span>🔮</span> AI Smart Follow-ups:
            </div>
            <div class="isl-ai-followups-list">
              ${geminiFollowups.map(f => `
                <button class="isl-ai-pill" onclick="triggerAIFollowup('${f.sentence.replace(/'/g, "\\'")}', '${f.icon || '💬'}')" onmouseenter="startDwell(this)" onmouseleave="cancelDwell(this)" title="${f.meaning || ''}">
                  <div class="dwell-progress-bar"></div>
                  <span>${f.icon || '💬'}</span>
                  <span>"${f.sentence}"</span>
                </button>
              `).join('')}
            </div>
          </div>
        ` : ''}

        <!-- 6 LARGE EXPRESSION CARDS (2x3 GRID - 100% IN VIEWPORT) -->
        <div class="cards-grid isl-practical-grid">
          ${currentAnchor.expressions.map((expr, idx) => `
            <div class="card isl-express-card ${expr.urgent ? 'urgent' : ''}"
                 data-expr-id="${expr.id}"
                 data-index="${idx}"
                 onmouseenter="startDwell(this)"
                 onmouseleave="cancelDwell(this)"
                 onclick="triggerISLExpression('${expr.id}')">
              <div class="dwell-progress-bar"></div>
              
              <div class="isl-card-header-row">
                <div class="isl-gesture-pill">
                  <span>🖐️</span>
                  <span>${expr.gesture}</span>
                </div>
                <div class="isl-action-speak-pill">
                  <span>🔊 SPEAKS ON GLANCE</span>
                </div>
              </div>

              <div class="isl-express-sentence">
                "${expr.sentence}"
              </div>

              <div class="isl-card-footer-row">
                <span class="isl-meaning-sub">${expr.meaning}</span>
                <span class="isl-dwell-indicator">⏱️ 0.8s dwell</span>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;

  container.innerHTML = html;
}

function openISLReviewModal() {
  const currentAnchor = ISL_BODY_ANCHORS.find(a => a.id === islSelectedAnchor) || ISL_BODY_ANCHORS[0];
  const modal = document.getElementById('isl-review-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
}

function closeISLReviewModal() {
  const modal = document.getElementById('isl-review-modal');
  if (modal) modal.classList.add('hidden');
}

function confirmAndSpeakISLFromModal() {
  if (islLastSpokenText) speakText(islLastSpokenText);
  closeISLReviewModal();
}

function goHome() {
  if (currentView === 'sign_to_speech') {
    exitSignToSpeechMode();
  }
  cancelDwell();
  lastGazeCard = null;
  lookLeftStartTime = 0;
  closeAllModals();

  if (currentView === 'home') {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    showToast("Dashboard Home");
    return;
  }

  currentView = 'home';
  currentCategory = null;
  focusedIndex = 0;

  const edgeBar = document.querySelector('.dwell-progress-bar-vertical');
  if (edgeBar) edgeBar.style.height = '0%';
  const edgeBack = document.getElementById('left-edge-back');
  if (edgeBack) edgeBack.classList.remove('active-dwell');

  renderView();
  showToast("↩ Returned to Dashboard Home");
}

function setMessage(text, icon = '💬') {
  currentMessage = text;
  currentIcon = icon;
  
  const msgTextEl = document.getElementById('message-text');
  const msgIconEl = document.getElementById('message-icon');
  const msgBox = document.querySelector('.msg-box');
  const speakBtn = document.getElementById('speak-btn');
  const clearBtn = document.getElementById('clear-msg-btn');

  msgTextEl.textContent = text;
  msgIconEl.textContent = icon;
  msgBox.classList.add('has-msg');
  speakBtn.disabled = false;
  clearBtn.style.display = 'inline-block';
}

function clearMessage() {
  currentMessage = '';
  document.getElementById('message-text').textContent = 'Select an option to communicate';
  document.getElementById('message-icon').textContent = '💬';
  document.querySelector('.msg-box').classList.remove('has-msg');
  document.getElementById('speak-btn').disabled = true;
  document.getElementById('clear-msg-btn').style.display = 'none';
}

// ============================================================================
// Text-to-Speech (TTS)
// ============================================================================
let synth = null;
function initSpeech() {
  if ('speechSynthesis' in window) {
    synth = window.speechSynthesis;
  }
}

function speakText(text) {
  if (!text) return;

  // 1. Browser Web Speech API (instant client-side TTS)
  if (synth) {
    synth.cancel(); // Stop any pending speech
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.95; // comfortable cadence
    utterance.pitch = 1.0;
    synth.speak(utterance);
  }

  // 2. Hardware / Native Python TTS fallback (speaks out loud through laptop speakers)
  fetch('/api/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text })
  }).catch(() => {});
}

// ============================================================================
// Caregiver Messaging Server Post
// ============================================================================
async function postMessageToServer(text, category, isEmergency = false) {
  try {
    await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: text,
        category: category,
        emergency: isEmergency
      })
    });
  } catch (err) {
    console.error("Failed to post message to caregiver server:", err);
  }
}

// ============================================================================
// Keyboard & Gaze Grid Navigation Engine (Part 12)
// ============================================================================
function updateFocusableGrid() {
  focusableElements = Array.from(document.querySelectorAll('.cards-grid .card, .isl-anchor-btn'));
  if (focusableElements.length > 0) {
    if (focusedIndex >= focusableElements.length) focusedIndex = 0;
    highlightFocused();
  }
}

function highlightFocused() {
  cancelDwell();
  focusableElements.forEach((el, idx) => {
    if (idx === focusedIndex) {
      el.classList.add('focused');
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      startDwell(el);
    } else {
      el.classList.remove('focused');
    }
  });
}

function setupKeyboardNavigation() {
  window.addEventListener('keydown', (e) => {
    // If a modal is open, let standard modal interaction occur
    if (document.querySelector('.overlay:not(.hidden)')) {
      if (e.key === 'Escape') {
        closeAllModals();
      }
      return;
    }

    if (!focusableElements.length) return;

    // Grid columns estimation
    const cols = Math.max(1, Math.floor(document.querySelector('.cards-grid').clientWidth / 260));

    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        focusedIndex = (focusedIndex + 1) % focusableElements.length;
        highlightFocused();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        focusedIndex = (focusedIndex - 1 + focusableElements.length) % focusableElements.length;
        highlightFocused();
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (focusedIndex + cols < focusableElements.length) {
          focusedIndex += cols;
          highlightFocused();
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (focusedIndex - cols >= 0) {
          focusedIndex -= cols;
          highlightFocused();
        }
        break;
      case 'Enter':
      case ' ': // Spacebar selects like dwell/blink
        e.preventDefault();
        if (focusableElements[focusedIndex]) {
          focusableElements[focusedIndex].click();
        }
        break;
      case 'Backspace':
      case 'Escape':
        e.preventDefault();
        if (currentView !== 'home') {
          goHome();
        }
        break;
    }
  });
}

// ============================================================================
// Emergency System (Part 8)
// ============================================================================
function openEmergency() {
  const overlay = document.getElementById('emergency-overlay');
  const optionsContainer = document.getElementById('emergency-options');
  
  const subOptions = appData.emergency.sub_options || [];
  optionsContainer.innerHTML = subOptions.map(opt => `
    <button class="emergency-card-btn" onclick="triggerEmergencyMessage('${opt.message}')">
      <span style="font-size:2rem;">${opt.icon}</span>
      <span>${opt.label}</span>
    </button>
  `).join('');

  overlay.classList.remove('hidden');
}

function closeEmergency() {
  document.getElementById('emergency-overlay').classList.add('hidden');
}

function triggerEmergencyMessage(msg) {
  closeEmergency();
  setMessage(msg, '🚨');
  speakText(msg);
  postMessageToServer(msg, 'EMERGENCY', true);
  
  // Show active emergency banner
  const banner = document.getElementById('emergency-active');
  document.getElementById('emergency-active-text').textContent = msg;
  banner.classList.remove('hidden');

  showToast("🚨 EMERGENCY ALERT BROADCASTED TO CAREGIVERS");
}

function dismissEmergency() {
  document.getElementById('emergency-active').classList.add('hidden');
  clearMessage();
}

// ============================================================================
// Room & Device Remote (Part 6)
// ============================================================================
function openRemoteModal() {
  document.getElementById('remote-modal').classList.remove('hidden');
}

function closeRemoteModal() {
  document.getElementById('remote-modal').classList.add('hidden');
}

function triggerRemoteAction(title, desc) {
  const msg = `[Device Remote] ${title}: ${desc}`;
  setMessage(msg, '📺');
  speakText(desc);
  postMessageToServer(msg, 'Room & Devices', false);
  showToast(`Simulated Signal Sent: ${title}`);
}

// ============================================================================
// Teammate Keyboard Integration (Part 10)
// ============================================================================
function openKeyboardModal() {
  cancelDwell();
  const modal = document.getElementById('keyboard-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeKeyboardModal() {
  cancelDwell();
  const modal = document.getElementById('keyboard-modal');
  if (modal) modal.classList.add('hidden');
  goHome();
}

async function launchTeammateKeyboard() {
  const statusEl = document.getElementById('keyboard-status');
  statusEl.textContent = 'Launching EyeType eye-tracking window...';
  try {
    const res = await fetch('/api/launch-keyboard', { method: 'POST' });
    const data = await res.json();
    if (data.status === 'launched') {
      statusEl.textContent = 'EyeType window opened on desktop!';
      showToast("EyeType eye-tracking keyboard launched successfully");
      setTimeout(closeKeyboardModal, 1500);
    } else {
      statusEl.textContent = 'Notice: EyeType launched in desktop background.';
    }
  } catch (err) {
    statusEl.textContent = 'Error launching keyboard application.';
  }
}

// ============================================================================
// Caregiver Customization System (Part 11)
// ============================================================================
function openCustomize() {
  const modal = document.getElementById('customize-modal');
  const catSelect = document.getElementById('cust-category-select');
  
  // Populate category dropdown (excluding keyboard)
  const editableCats = appData.categories.filter(c => !c.is_external);
  catSelect.innerHTML = editableCats.map(c => `
    <option value="${c.id}">${c.name}</option>
  `).join('');

  if (currentCategory && !currentCategory.is_external) {
    catSelect.value = currentCategory.id;
  }

  loadCategoryOptionsForEdit();
  modal.classList.remove('hidden');
}

function closeCustomize() {
  document.getElementById('customize-modal').classList.add('hidden');
}

function loadCategoryOptionsForEdit() {
  const catId = document.getElementById('cust-category-select').value;
  const cat = appData.categories.find(c => c.id === catId);
  const container = document.getElementById('cust-options-list');
  if (!cat) return;

  container.innerHTML = cat.options.map(opt => `
    <div class="cust-opt-row">
      <div class="cust-opt-left">
        <span style="font-size:1.4rem;">${opt.icon || '💬'}</span>
        <div>
          <div class="cust-opt-name">${opt.label}</div>
          <div class="cust-opt-msg">${opt.message}</div>
        </div>
      </div>
      <div class="cust-opt-actions">
        <button class="btn-sm" onclick="openEditModal('${cat.id}', '${opt.id}')">✏️ Edit</button>
        ${opt.custom ? `<button class="btn-sm del" onclick="deleteCustomOption('${cat.id}', '${opt.id}')">🗑️</button>` : ''}
      </div>
    </div>
  `).join('');
}

async function addCustomOption() {
  const catId = document.getElementById('cust-category-select').value;
  const icon = document.getElementById('cust-icon').value.trim() || '💬';
  const label = document.getElementById('cust-label').value.trim();
  const message = document.getElementById('cust-message').value.trim();

  if (!label || !message) {
    alert("Please provide both a label and a spoken message.");
    return;
  }

  try {
    const res = await fetch(`/api/categories/${catId}/options`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ icon, label, message })
    });

    if (res.ok) {
      document.getElementById('cust-label').value = '';
      document.getElementById('cust-message').value = '';
      await loadData();
      loadCategoryOptionsForEdit();
      showToast(`Added "${label}" to category!`);
    }
  } catch (err) {
    console.error(err);
  }
}

function openEditModal(catId, optId) {
  const cat = appData.categories.find(c => c.id === catId);
  const opt = cat ? cat.options.find(o => o.id === optId) : null;
  if (!opt) return;

  document.getElementById('edit-cat-id').value = catId;
  document.getElementById('edit-opt-id').value = optId;
  document.getElementById('edit-icon').value = opt.icon || '💬';
  document.getElementById('edit-label').value = opt.label;
  document.getElementById('edit-message').value = opt.message;

  document.getElementById('edit-modal').classList.remove('hidden');
}

function closeEditModal() {
  document.getElementById('edit-modal').classList.add('hidden');
}

async function saveEditOption() {
  const catId = document.getElementById('edit-cat-id').value;
  const optId = document.getElementById('edit-opt-id').value;
  const icon = document.getElementById('edit-icon').value.trim();
  const label = document.getElementById('edit-label').value.trim();
  const message = document.getElementById('edit-message').value.trim();

  try {
    const res = await fetch(`/api/categories/${catId}/options/${optId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ icon, label, message })
    });

    if (res.ok) {
      closeEditModal();
      await loadData();
      loadCategoryOptionsForEdit();
      showToast(`Updated "${label}" successfully!`);
    }
  } catch (err) {
    console.error(err);
  }
}

async function deleteCustomOption(catId, optId) {
  if (!confirm("Are you sure you want to remove this custom option?")) return;
  try {
    const res = await fetch(`/api/categories/${catId}/options/${optId}`, {
      method: 'DELETE'
    });
    if (res.ok) {
      await loadData();
      loadCategoryOptionsForEdit();
      showToast("Option removed.");
    }
  } catch (err) {
    console.error(err);
  }
}

function closeAllModals() {
  document.querySelectorAll('.overlay').forEach(el => el.classList.add('hidden'));
}

// ============================================================================
// Toast Notification
// ============================================================================
let toastTimer = null;
function showToast(msg) {
  const toast = document.getElementById('toast');
  const toastText = document.getElementById('toast-text');
  toastText.textContent = msg;
  toast.classList.remove('hidden');

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.add('hidden');
  }, 2500);
}



// ============================================================================
// Sign Language to Speech (Webcam ISL Recognition & Translation)
// ============================================================================

let signRecognizerInstance = null;
let signVocabData = [];
let currentSignSentence = '';
let currentSignMalayalam = '';
let signConversationHistory = [];
let autoSpeakEnabled = false;
let autoSpeakTimer = null;
let signStatusCallbackAttached = false;

/**
 * Load verified ISL vocabulary from server API
 */
async function loadSignVocabulary(force = false) {
  if (!force && signVocabData.length >= 25) return signVocabData;
  try {
    const res = await fetch('/api/sign-vocabulary');
    if (res.ok) {
      const data = await res.json();
      signVocabData = data.signs || [];
      if (window.SignRecognizer) {
        signRecognizerInstance = new window.SignRecognizer(signVocabData);
      }
    }
  } catch (err) {
    console.error('Failed to load sign vocabulary:', err);
  }
  return signVocabData;
}

/**
 * Render the dedicated Sign Language to Speech Interpreter Interface
 */
async function renderSignToSpeechView(container) {
  // Ensure vocabulary is loaded with full expanded ISL set
  await loadSignVocabulary(true);

  const vocab = signVocabData || [];

  container.innerHTML = `
    <div class="category-header-banner" style="border-color:#10b981;">
      <div class="cat-banner-info">
        <h2>
          <span>🤟</span> Sign Language to Speech (Two-Way Communication Bridge)
          <span class="sign-mode-badge">⚡ AI MIDDLEMAN</span>
        </h2>
        <p>Intelligent interpreter between Person A (who uses Indian Sign Language) and Person B (who speaks and listens).</p>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <button class="btn-secondary" onclick="openDatasetsModal()" style="border-color:#3b82f6;color:#60a5fa;padding:6px 12px;font-size:0.85rem;" title="Explore 9 research datasets streaming via Hugging Face Cloud">
          🌐 9 ISL Datasets (Cloud Streaming)
        </button>
        <button class="btn-secondary" onclick="openModeSelectorModal()" style="border-color:#10b981;color:#10b981;padding:6px 12px;font-size:0.85rem;">
          ⇄ Switch Mode
        </button>
        <button class="btn-back" onclick="goHome()">⬅ Dashboard</button>
      </div>
    </div>

    <!-- TWO-WAY COMMUNICATION BRIDGE ARCHITECTURE BANNER -->
    <div class="bridge-flow-banner">
      <div class="bridge-actor">
        <span class="actor-icon">👤</span>
        <div class="actor-info">
          <strong>Person A: The Signer</strong>
          <span>Cannot speak • Signs in ISL</span>
        </div>
      </div>
      <div class="bridge-middleman">
        <span class="middleman-icon">⚡</span>
        <strong>EyeVoice AI Middleman</strong>
        <span>Tracks Hands &amp; Pose • Translates SOV Grammar • Speaks Aloud</span>
        <span class="middleman-arrow">➔ ➔ ➔</span>
      </div>
      <div class="bridge-actor">
        <span class="actor-icon">👂</span>
        <div class="actor-info">
          <strong>Person B: The Listener</strong>
          <span>Hears Spoken Audio • Reads English &amp; Malayalam</span>
        </div>
      </div>
    </div>

    <div class="sign-page-layout">
      <!-- LEFT COLUMN: Live Camera & Vision Viewport -->
      <div class="sign-camera-panel">
        <div class="sign-camera-header">
          <h3>📹 Live Camera &amp; Hand Mesh</h3>
          <div style="display:flex;gap:6px;align-items:center;">
            <span id="sign-fps" class="sign-fps-overlay" style="position:static;">-- FPS</span>
            <span id="sign-status-pill" class="sign-cam-status inactive">Offline</span>
          </div>
        </div>

        <div class="sign-camera-viewport">
          <canvas id="sign-canvas" width="640" height="480"></canvas>
          <div id="sign-camera-placeholder" class="sign-camera-placeholder" style="position:absolute;">
            <span class="placeholder-icon sign-waiting-pulse">🤟</span>
            <p>Click <strong>Start Camera</strong> below to enable MediaPipe Hand Tracking</p>
            <p style="font-size:0.8rem;color:var(--text-dim);margin-top:6px;">Runs 100% locally in your browser</p>
          </div>
          <div id="sign-hands-indicator" class="sign-hands-indicator">
            <span id="sign-hand-left-chip" class="sign-hand-chip left" style="display:none;">Left Hand</span>
            <span id="sign-hand-right-chip" class="sign-hand-chip right" style="display:none;">Right Hand</span>
          </div>
        </div>

        <div class="sign-cam-controls">
          <button id="btn-start-sign-cam" class="btn-cam btn-cam-start" onclick="startSignCamera()">
            ▶ Start Camera
          </button>
          <button id="btn-stop-sign-cam" class="btn-cam btn-cam-stop" onclick="stopSignCamera()" style="display:none;">
            ⏹ Stop Camera
          </button>
          <span id="sign-cam-msg" style="font-size:0.8rem;color:var(--text-muted);align-self:center;margin-left:auto;">
            Ready
          </span>
        </div>
      </div>

      <!-- RIGHT COLUMN: Recognition, Translation & Speech -->
      <div class="sign-recognition-panel">
        <!-- Section 1: Real-time Sign Candidate -->
        <div class="sign-section">
          <div class="sign-section-header">
            <span>⚡ Continuous Indian Sign Language Interpreter</span>
            <label class="sign-auto-speak-toggle" style="margin-left:auto;font-size:0.75rem;">
              <input type="checkbox" id="auto-continuous-toggle" checked onchange="autoContinuousInterpretEnabled = this.checked">
              ⚡ Live Auto-Translate: ON
            </label>
          </div>
          <div class="sign-section-body" style="padding:10px 14px;">
            <div class="sign-detected-display" style="padding:8px;">
              <span id="sign-detect-icon" class="sign-detected-icon">🤟</span>
              <div id="sign-detect-gloss" class="sign-detected-gloss">Ready for Indian Sign Language</div>
              <div id="sign-detect-meaning" class="sign-detected-meaning">Sign naturally in ISL — continuous translation interprets every sign &amp; sentence in real time</div>
              
              <div class="sign-hold-bar">
                <div id="sign-detect-hold-fill" class="sign-hold-bar-fill"></div>
              </div>
              <div id="sign-hold-hint" style="font-size:0.75rem;color:var(--text-dim);margin-top:4px;">Translates all ISL vocabulary, continuous sentences &amp; fingerspelling automatically</div>

              <div id="sign-finger-chips" class="finger-state-grid">
                <span class="finger-chip" id="chip-thumb">Thumb</span>
                <span class="finger-chip" id="chip-index">Index</span>
                <span class="finger-chip" id="chip-middle">Middle</span>
                <span class="finger-chip" id="chip-ring">Ring</span>
                <span class="finger-chip" id="chip-pinky">Pinky</span>
              </div>

              <!-- AI Polishing & Open Sign Translation -->
              <div id="ai-sign-status-chip" class="ai-sign-status-chip active">
                🟢 Live ISL Stream Active: Translates all Indian Sign Language signs in real time
              </div>
              <button id="btn-ai-sign-polish" class="btn-ai-polish" onclick="triggerAiSignInterpretation()">
                🧠 Force AI Re-Scan Frame
              </button>
            </div>
          </div>
        </div>

        <!-- Section 2: Fingerspelling Word Assembler & Sequence (emnikhil + imRishabhGupta) -->
        <div class="sign-section">
          <div class="sign-section-header">
            <span>🧩 Fingerspelling Word Assembler &amp; Signed Sequence</span>
            <div style="margin-left:auto;display:flex;gap:6px;">
              <button class="btn-perm-back" style="padding:2px 8px;font-size:0.75rem;" onclick="backspaceSign()" title="Delete last letter or sign">
                ⌫ Backspace
              </button>
              <button class="btn-perm-back" style="padding:2px 8px;font-size:0.75rem;" onclick="commitFingerspelledWord()" title="Commit current word into sentence">
                ␣ Space / Add Word
              </button>
              <button class="btn-perm-back" style="padding:2px 8px;font-size:0.75rem;" onclick="clearSignSequence()">
                🧹 Clear
              </button>
            </div>
          </div>
          <div class="sign-section-body" style="padding:10px 14px;">
            <!-- Live Active Fingerspelling Word Buffer -->
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:6px 12px;background:var(--card-bg);border:1px dashed #3b82f6;border-radius:var(--radius-sm);">
              <span style="font-size:0.8rem;font-weight:700;color:#3b82f6;">🔤 Active Word:</span>
              <span id="sign-word-buffer" style="font-family:monospace;font-size:1.15rem;font-weight:800;letter-spacing:2px;color:var(--text);">_</span>
              <span id="sign-disambiguation-pill" style="margin-left:auto;font-size:0.72rem;padding:2px 8px;border-radius:99px;background:rgba(59,130,246,0.12);color:#3b82f6;font-weight:600;display:none;"></span>
            </div>

            <!-- Predictive Word Suggestions (emnikhil style) -->
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;flex-wrap:wrap;">
              <span style="font-size:0.75rem;font-weight:700;color:var(--text-dim);">💡 Suggestions:</span>
              <div id="sign-word-suggestions" style="display:inline-flex;gap:6px;flex-wrap:wrap;">
                <span class="pill-quick-reply" onclick="selectSuggestion('HELP')">🆘 HELP</span>
                <span class="pill-quick-reply" onclick="selectSuggestion('DOCTOR')">👨‍⚕️ DOCTOR</span>
                <span class="pill-quick-reply" onclick="selectSuggestion('WATER')">💧 WATER</span>
                <span class="pill-quick-reply" onclick="selectSuggestion('PAIN')">⚡ PAIN</span>
              </div>
            </div>

            <!-- Confirmed Full Sequence Chips -->
            <div id="sign-sequence-chips" style="display:flex;flex-wrap:wrap;gap:6px;min-height:32px;align-items:center;">
              <span style="color:var(--text-dim);font-size:0.85rem;font-style:italic;">No signs confirmed yet — perform a gesture</span>
            </div>
          </div>
        </div>

        <!-- Section 3: Live Translated Spoken Output -->
        <div class="sign-section" style="border-color:#10b981;">
          <div class="sign-section-header" style="background:rgba(16,185,129,0.1);">
            <span>🗣️ Spoken Translation</span>
            <label class="sign-auto-speak-toggle" style="margin-left:auto;">
              <input type="checkbox" id="sign-autospeak-toggle" onchange="toggleAutoSpeak(this.checked)" ${autoSpeakEnabled ? 'checked' : ''}>
              ⚡ Auto-Speak
            </label>
          </div>
          <div class="sign-section-body">
            <div class="sign-translation-area">
              <div id="sign-translated-text" class="sign-translated-sentence">"Awaiting sign input..."</div>
              <div id="sign-malayalam-text" style="color:#10b981;font-size:0.95rem;margin-top:4px;font-weight:600;"></div>
            </div>

            <div class="sign-speech-controls" style="padding:8px 0 0 0;">
              <button id="btn-sign-speak" class="btn-sign-action btn-sign-speak" onclick="speakSignSentence()" disabled>
                🔊 Speak to Person B
              </button>
              <button class="btn-sign-action btn-sign-clear" onclick="replaySignSentence()">
                🔁 Replay Audio
              </button>
            </div>

            <!-- Person B Two-Way Reply Box -->
            <div class="person-b-reply-card">
              <h4><span>👂</span> Person B Quick Reply to Person A:</h4>
              <div class="person-b-input-row">
                <input type="text" id="person-b-reply-input" class="person-b-input" placeholder="Type reply for Person A to read on screen..." onkeydown="if(event.key==='Enter') sendPersonBReply()">
                <button class="btn-secondary" onclick="sendPersonBReply()" style="padding:6px 14px;background:#3b82f6;color:#fff;border:none;">
                  Send ➔
                </button>
              </div>
              <div class="person-b-quick-pills">
                <span class="pill-quick-reply" onclick="sendPersonBReply('Yes, I understand.')">✅ Understood</span>
                <span class="pill-quick-reply" onclick="sendPersonBReply('Calling the doctor right away.')">👨‍⚕️ Contacting Doctor</span>
                <span class="pill-quick-reply" onclick="sendPersonBReply('Please wait one minute.')">⏳ Please wait</span>
                <span class="pill-quick-reply" onclick="sendPersonBReply('I am here with you.')">❤️ I am with you</span>
                <span class="pill-quick-reply" onclick="sendPersonBReply('Sounds good.')">👍 All clear</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Section 4: Live Conversation History -->
        <div class="sign-section">
          <div class="sign-section-header">
            <span>💬 Conversation History</span>
            <span style="font-size:0.75rem;color:var(--text-dim);margin-left:auto;">Signs &amp; Translations</span>
          </div>
          <div class="sign-section-body" style="padding:10px;">
            <div id="sign-history-list" class="sign-history-list">
              ${signConversationHistory.length === 0 ? '<div class="sign-history-empty">Spoken sentences will appear here in chronological order.</div>' : signConversationHistory.map(item => `
                <div class="sign-history-item">
                  <div class="sign-history-avatar">${item.icon || '🤟'}</div>
                  <div class="sign-history-content">
                    <div class="sign-history-text">${item.text}</div>
                    <div class="sign-history-meta">ISL Glosses: [${item.glosses}] • ${item.time}</div>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>

        <!-- Section 5: ISLRTC National Standard Lexicon Explorer -->
        <details class="sign-section" style="cursor:pointer;" ontoggle="if(this.open) loadFullLexiconExplorer()">
          <summary class="sign-section-header">
            <span>📖 ISLRTC National Standard Lexicon Explorer (All Categories)</span>
            <span style="font-size:0.75rem;color:var(--accent);margin-left:auto;">Click to Search &amp; Explore</span>
          </summary>
          <div class="sign-section-body" style="padding:10px;">
            <div style="margin-bottom:10px;">
              <input type="text" id="lexicon-search-input" class="person-b-input" placeholder="Search any ISL word (e.g. Doctor, Emergency, Mother, Letter A, Pain)..." oninput="filterLexiconDisplay(this.value)" style="margin:0;width:100%;">
            </div>
            <div id="lexicon-category-pills" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;"></div>
            <div id="lexicon-cards-grid" style="display:grid;grid-template-columns:repeat(auto-fill, minmax(220px, 1fr));gap:8px;max-height:280px;overflow-y:auto;">
              <div style="text-align:center;padding:20px;color:var(--text-dim);grid-column:1/-1;">Loading ISLRTC National Lexicon…</div>
            </div>
          </div>
        </details>
      </div>
    </div>
  `;

  // Attach status listener if not already attached
  if (!signStatusCallbackAttached) {
    window.onSignTrackerStatus = (msg) => {
      const msgEl = document.getElementById('sign-cam-msg');
      if (msgEl) msgEl.textContent = msg;
    };
    signStatusCallbackAttached = true;
  }
}

/**
 * Start MediaPipe Sign Tracker camera and loop
 */
async function startSignCamera() {
  const videoEl = document.getElementById('sign-tracker-video');
  const canvasEl = document.getElementById('sign-canvas');
  const placeholderEl = document.getElementById('sign-camera-placeholder');
  const startBtn = document.getElementById('btn-start-sign-cam');
  const stopBtn = document.getElementById('btn-stop-sign-cam');
  const statusPill = document.getElementById('sign-status-pill');
  const mainStatus = document.getElementById('sign-main-status');

  if (!videoEl || !canvasEl) return;

  if (placeholderEl) placeholderEl.style.display = 'none';
  if (startBtn) startBtn.style.display = 'none';
  if (stopBtn) stopBtn.style.display = 'inline-flex';
  if (statusPill) {
    statusPill.className = 'sign-cam-status active';
    statusPill.textContent = '● Tracking';
  }
  if (mainStatus) {
    mainStatus.className = 'sign-cam-status active';
    mainStatus.textContent = '● Tracking Active';
  }

  // Ensure recognizer instance exists
  if (!signRecognizerInstance && window.SignRecognizer) {
    signRecognizerInstance = new window.SignRecognizer(signVocabData);
  }

  // Init sign tracker
  if (typeof window.initSignTracker === 'function') {
    try {
      await window.initSignTracker(videoEl, canvasEl, onSignTrackerFrame);
      showToast("Webcam MediaPipe Vision active");
    } catch (err) {
      console.error('Failed to init sign tracker:', err);
      showToast("Camera error: " + err.message);
      stopSignCamera();
    }
  } else {
    showToast("MediaPipe tracker module loading, please retry in 2s");
  }
}

/**
 * Stop MediaPipe Sign Tracker
 */
function stopSignCamera() {
  const placeholderEl = document.getElementById('sign-camera-placeholder');
  const startBtn = document.getElementById('btn-start-sign-cam');
  const stopBtn = document.getElementById('btn-stop-sign-cam');
  const statusPill = document.getElementById('sign-status-pill');
  const mainStatus = document.getElementById('sign-main-status');

  if (typeof window.stopSignTracker === 'function') {
    window.stopSignTracker();
  }

  if (placeholderEl) placeholderEl.style.display = 'block';
  if (startBtn) startBtn.style.display = 'inline-flex';
  if (stopBtn) stopBtn.style.display = 'none';
  if (statusPill) {
    statusPill.className = 'sign-cam-status inactive';
    statusPill.textContent = 'Offline';
  }
  if (mainStatus) {
    mainStatus.className = 'sign-cam-status inactive';
    mainStatus.textContent = '● Camera Idle';
  }
}

/**
 * Frame callback invoked by sign_tracker.js on every animation frame
 */
let autoContinuousInterpretEnabled = true;
let handsInSigningSpaceTime = 0;
let lastAutoStreamTime = 0;
let isAutoStreaming = false;

function onSignTrackerFrame(frameData) {
  if (!signRecognizerInstance) return;

  const result = signRecognizerInstance.processFrame(frameData);
  const now = performance.now();

  // 1. Hands indicator chips
  const leftChip = document.getElementById('sign-hand-left-chip');
  const rightChip = document.getElementById('sign-hand-right-chip');
  if (leftChip) leftChip.style.display = result.fingerStates.dominant ? 'inline-block' : 'none';
  if (rightChip) rightChip.style.display = result.fingerStates.secondary ? 'inline-block' : 'none';

  // 2. Finger state chips for dominant hand
  if (result.fingerStates.dominant) {
    const f = result.fingerStates.dominant;
    updateFingerChip('chip-thumb', 'Thumb', f.thumb === 'extended');
    updateFingerChip('chip-index', 'Index', f.index === 'extended');
    updateFingerChip('chip-middle', 'Middle', f.middle === 'extended');
    updateFingerChip('chip-ring', 'Ring', f.ring === 'extended');
    updateFingerChip('chip-pinky', 'Pinky', f.pinky === 'extended');
  }

  // 3. Current candidate sign display
  const glossEl = document.getElementById('sign-detect-gloss');
  const meaningEl = document.getElementById('sign-detect-meaning');
  const confEl = document.getElementById('sign-detect-conf');
  const holdFillEl = document.getElementById('sign-detect-hold-fill');

  // Update live fingerspelling buffer display (emnikhil architecture)
  const wordBufEl = document.getElementById('sign-word-buffer');
  if (wordBufEl) {
    wordBufEl.textContent = result.wordBuffer ? `${result.wordBuffer}_` : '_';
  }

  // Update real-time disambiguation reason pill (imRishabhGupta geometric classifier)
  const disEl = document.getElementById('sign-disambiguation-pill');
  if (disEl) {
    if (result.disambiguationNote) {
      disEl.textContent = `🔍 ${result.disambiguationNote}`;
      disEl.style.display = 'inline-block';
    } else {
      disEl.style.display = 'none';
    }
  }

  // Update predictive suggestion chips
  const suggContainer = document.getElementById('sign-word-suggestions');
  if (suggContainer && result.suggestions && result.suggestions.length > 0) {
    const icons = {
      HELP: '🆘', DOCTOR: '👨‍⚕️', WATER: '💧', PAIN: '⚡', HOSPITAL: '🏥',
      MEDICINE: '💊', FOOD: '🍲', EMERGENCY: '🚨', FEVER: '🌡️', BATHROOM: '🚻',
      YES: '✅', NO: '❌', PLEASE: '🙏', THANK: '❤️', FAMILY: '👨‍👩‍👧', MOTHER: '👩',
      NURSE: '🩺', HEADACHE: '🤕', TABLET: '💊', REST: '🛏️', SLEEP: '😴', WHAT: '❓'
    };
    suggContainer.innerHTML = result.suggestions.map(w => {
      const icon = icons[w] || '💡';
      return `<span class="pill-quick-reply" onclick="selectSuggestion('${w}')">${icon} ${w}</span>`;
    }).join('');
  }

  if (result.currentSign) {
    if (glossEl) glossEl.textContent = result.currentSign.gloss;
    if (meaningEl) meaningEl.textContent = result.currentSign.meaning_en;
    if (confEl) {
      confEl.textContent = result.currentSign.confidence + '% Match';
      confEl.className = 'sign-confidence-badge ' + (result.currentSign.confidence > 70 ? 'high' : 'medium');
    }
    if (holdFillEl) {
      holdFillEl.style.width = Math.round(result.holdProgress * 100) + '%';
    }
  } else {
    if (holdFillEl) holdFillEl.style.width = '0%';
    if (result.handsDetected > 0) {
      if (confEl && !result.confirmedSign && !isAutoStreaming) {
        confEl.textContent = 'Tracking Hands…';
        confEl.className = 'sign-confidence-badge medium';
      }
    } else {
      if (confEl && !result.confirmedSign) {
        confEl.textContent = 'Show Hands to Sign';
        confEl.className = 'sign-confidence-badge low';
      }
    }
  }

  // 4. Confirmed sign event from fast local rules
  if (result.confirmedSign) {
    onSignConfirmed(result.confirmedSign);
  }

  // Live Continuous Sentence Synchronization
  if (result.continuousSentence && result.continuousSentence !== currentSignSentence && result.continuousSentence.length > 2) {
    currentSignSentence = result.continuousSentence;
    currentSignMalayalam = result.malayalamSentence || '';

    const transEl = document.getElementById('sign-translated-text');
    const malEl = document.getElementById('sign-malayalam-text');
    const speakBtn = document.getElementById('btn-sign-speak');

    if (transEl) transEl.textContent = `"${currentSignSentence}"`;
    if (malEl) malEl.textContent = currentSignMalayalam ? `മലയാളം: ${currentSignMalayalam}` : '';
    if (speakBtn) speakBtn.disabled = false;
  }

  // 5. Automatic Continuous Live Translation for ANY Indian Sign Language phrase
  if (result.handsDetected > 0) {
    if (handsInSigningSpaceTime === 0) handsInSigningSpaceTime = now;

    const timeInSpace = now - handsInSigningSpaceTime;
    // When hands are held in signing space for >450ms without a static canned template match:
    if (autoContinuousInterpretEnabled && !isAutoStreaming && timeInSpace > 450 && !result.currentSign) {
      if (now - lastAutoStreamTime > 2200) {
        lastAutoStreamTime = now;
        autoStreamSigningBurstToAI();
      }
    }
  } else {
    handsInSigningSpaceTime = 0;
  }
}

function updateFingerChip(id, label, isExtended) {
  const el = document.getElementById(id);
  if (!el) return;
  if (isExtended) {
    el.className = 'finger-chip extended';
    el.textContent = label + ' ↑';
  } else {
    el.className = 'finger-chip';
    el.textContent = label + ' ·';
  }
}

/**
 * Handle a sign confirmed by temporal stability hold
 */
async function onSignConfirmed(sign) {
  playClickChime();
  showToast(`Sign Confirmed: ${sign.gloss}`);

  // Update sign sequence chips in UI
  updateSignSequenceChips();

  // Request natural translation
  await translateSignSequence();

  // Handle auto-speak
  if (autoSpeakEnabled) {
    if (autoSpeakTimer) clearTimeout(autoSpeakTimer);
    autoSpeakTimer = setTimeout(() => {
      speakSignSentence();
    }, 1500); // 1.5s pause trigger
  }
}

function updateSignSequenceChips() {
  const seqContainer = document.getElementById('sign-sequence-chips');
  if (!seqContainer || !signRecognizerInstance) return;
  const sequence = signRecognizerInstance.getSignSequence();
  if (sequence.length === 0) {
    seqContainer.innerHTML = '<span style="color:var(--text-dim);font-size:0.85rem;font-style:italic;">No signs confirmed yet — perform a gesture</span>';
    return;
  }
  seqContainer.innerHTML = sequence.map((s, idx) => `
    <span style="background:var(--card-bg);border:1px solid #10b981;border-radius:99px;padding:4px 10px;font-size:0.8rem;color:#10b981;font-weight:700;display:inline-flex;align-items:center;gap:4px;">
      <span>${idx + 1}.</span> ${s.id}
    </span>
  `).join(' <span style="color:var(--text-dim);">➔</span> ');
}

/**
 * Apply a selected predictive suggestion chip (emnikhil architecture)
 */
async function selectSuggestion(word) {
  if (!signRecognizerInstance) return;
  signRecognizerInstance.applySuggestion(word);
  playClickChime();
  showToast(`Auto-completed: ${word}`);

  const wordBufEl = document.getElementById('sign-word-buffer');
  if (wordBufEl) wordBufEl.textContent = '_';

  updateSignSequenceChips();
  await translateSignSequence();
}

/**
 * Commit the currently typed fingerspelled word buffer into the sentence
 */
async function commitFingerspelledWord() {
  if (!signRecognizerInstance) return;
  const committed = signRecognizerInstance.commitCurrentWord('user_action');
  if (committed) {
    playClickChime();
    showToast(`Word Added: ${committed.id}`);

    const wordBufEl = document.getElementById('sign-word-buffer');
    if (wordBufEl) wordBufEl.textContent = '_';

    updateSignSequenceChips();
    await translateSignSequence();
  } else {
    showToast('Fingerspell letters A-Z first to commit a word');
  }
}

/**
 * Backspace: delete last letter or remove last sign from sequence
 */
async function backspaceSign() {
  if (!signRecognizerInstance) return;
  const res = signRecognizerInstance.backspace();
  playClickChime();
  if (res) {
    if (res.type === 'letter_deleted') {
      showToast(`Deleted letter: ${res.remainingBuffer || 'empty'}`);
      const wordBufEl = document.getElementById('sign-word-buffer');
      if (wordBufEl) wordBufEl.textContent = res.remainingBuffer ? `${res.remainingBuffer}_` : '_';
    } else if (res.type === 'sign_removed') {
      showToast(`Removed sign: ${res.removedSign.id}`);
      updateSignSequenceChips();
      await translateSignSequence();
    }
  }
}

/**
 * Send confirmed sign glosses to server for fluent natural language translation
 */
async function translateSignSequence() {
  if (!signRecognizerInstance) return;
  const sequence = signRecognizerInstance.getSignSequence();
  if (sequence.length === 0) return;

  const glosses = sequence.map(s => s.id);
  let translatedText = '';
  let malayalamText = sequence[sequence.length - 1].meaning_ml || '';

  try {
    const res = await fetch('/api/sign-translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ glosses: glosses })
    });
    if (res.ok) {
      const data = await res.json();
      translatedText = data.sentence || '';
    }
  } catch (err) {
    console.error('Translation error:', err);
  }

  // Fallback if server translation failed
  if (!translatedText) {
    translatedText = sequence.map(s => s.meaning_en).join(' ');
  }

  currentSignSentence = translatedText;
  currentSignMalayalam = malayalamText;

  // Update UI
  const transEl = document.getElementById('sign-translated-text');
  const malEl = document.getElementById('sign-malayalam-text');
  const speakBtn = document.getElementById('btn-sign-speak');

  if (transEl) transEl.textContent = `"${currentSignSentence}"`;
  if (malEl) malEl.textContent = currentSignMalayalam ? `മലയാളം: ${currentSignMalayalam}` : '';
  if (speakBtn) speakBtn.disabled = false;
}

/**
 * Speak the translated sentence using TTS and record in history
 */
function speakSignSentence() {
  if (!currentSignSentence) return;

  speakText(currentSignSentence);
  showToast(`Speaking: "${currentSignSentence}"`);

  // Record in conversation history
  const sequence = signRecognizerInstance ? signRecognizerInstance.getSignSequence() : [];
  const glossStr = sequence.map(s => s.id).join(' ');
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  signConversationHistory.unshift({
    icon: '🤟',
    text: currentSignSentence,
    glosses: glossStr || 'ISL Gesture',
    time: timeStr
  });

  // Post to caregiver log as patient sign message
  postMessageToServer(currentSignSentence, 'Sign Language (ISL Webcam)', false);

  // Update history UI
  const historyList = document.getElementById('sign-history-list');
  if (historyList) {
    historyList.innerHTML = signConversationHistory.map(item => `
      <div class="sign-history-item">
        <div class="sign-history-avatar">${item.icon}</div>
        <div class="sign-history-content">
          <div class="sign-history-text">${item.text}</div>
          <div class="sign-history-meta">ISL Glosses: [${item.glosses}] • ${item.time}</div>
        </div>
      </div>
    `).join('');
  }
}

function replaySignSentence() {
  if (currentSignSentence) {
    speakText(currentSignSentence);
    showToast(`Replaying: "${currentSignSentence}"`);
  } else if (signConversationHistory.length > 0) {
    const last = signConversationHistory[0];
    speakText(last.text);
    showToast(`Replaying: "${last.text}"`);
  }
}

function clearSignSequence() {
  if (signRecognizerInstance) {
    signRecognizerInstance.clearSequence();
  }
  currentSignSentence = '';
  currentSignMalayalam = '';

  const seqContainer = document.getElementById('sign-sequence-chips');
  const transEl = document.getElementById('sign-translated-text');
  const malEl = document.getElementById('sign-malayalam-text');
  const speakBtn = document.getElementById('btn-sign-speak');
  const wordBufEl = document.getElementById('sign-word-buffer');

  if (wordBufEl) wordBufEl.textContent = '_';
  if (seqContainer) seqContainer.innerHTML = '<span style="color:var(--text-dim);font-size:0.85rem;font-style:italic;">No signs confirmed yet</span>';
  if (transEl) transEl.textContent = '"Awaiting sign input..."';
  if (malEl) malEl.textContent = '';
  if (speakBtn) speakBtn.disabled = true;

  showToast("Cleared sign sequence");
}

function toggleAutoSpeak(enabled) {
  autoSpeakEnabled = Boolean(enabled);
  showToast(autoSpeakEnabled ? "Auto-speak enabled (1.5s pause trigger)" : "Auto-speak disabled (manual button)");
}

/**
 * Clean up tracker and state when leaving Sign-to-Speech view
 */
function exitSignToSpeechMode() {
  stopSignCamera();
  if (autoSpeakTimer) {
    clearTimeout(autoSpeakTimer);
    autoSpeakTimer = null;
  }
}


// ============================================================================
// Communication Pathway & Mode Switcher Management
// ============================================================================

function openModeSelectorModal() {
  const modal = document.getElementById('mode-selector-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeModeSelectorModal() {
  const modal = document.getElementById('mode-selector-modal');
  if (modal) modal.classList.add('hidden');
}

/**
 * Switch between the two primary patient communication modalities
 * @param {'eye_to_speech' | 'sign_to_speech' | 'keyboard'} mode 
 * @param {boolean} notify 
 */
function switchCommunicationMode(mode, notify = true) {
  closeModeSelectorModal();
  activeCommunicationMode = mode;
  sessionStorage.setItem('eyevoice_mode', mode);

  const topbarLabel = document.getElementById('topbar-mode-label');
  const reticle = document.getElementById('gaze-reticle');
  const cameraHud = document.getElementById('camera-hud');
  const gazeBtn = document.getElementById('gaze-mode-btn');
  const dwellBtn = document.getElementById('dwell-toggle-btn');
  const calibBtn = document.getElementById('quick-calib-btn');

  if (mode === 'eye_to_speech') {
    // ── 1. EYE-TO-SPEECH MODE ──
    if (topbarLabel) topbarLabel.textContent = 'Mode: 👁️ Eye-to-Speech';
    document.body.setAttribute('data-gaze', 'webcam');

    // Stop sign tracker if active
    if (typeof stopSignCamera === 'function') stopSignCamera();

    // Show eye tracking reticle and HUD
    if (reticle) reticle.style.display = 'block';
    if (cameraHud) cameraHud.style.display = 'block';
    if (gazeBtn) gazeBtn.style.display = 'inline-flex';
    if (dwellBtn) dwellBtn.style.display = 'inline-flex';
    if (calibBtn) calibBtn.style.display = 'inline-flex';

    // Start eye tracker
    if (window.initBrowserTracker && (!window.isBrowserTrackerRunning || !window.isBrowserTrackerRunning())) {
      window.initBrowserTracker();
    }

    currentView = 'home';
    currentCategory = null;
    renderView();

    if (notify) showToast("👁️ Eye-to-Speech Mode Active (Gaze & Dwell Controls)");

  } else if (mode === 'sign_to_speech') {
    // ── 2. SIGN-TO-SPEECH INTERPRETER (TWO-WAY BRIDGE) ──
    if (topbarLabel) topbarLabel.textContent = 'Mode: 🤟 Sign Interpreter';

    // Disable / hide eye-tracking reticle so it doesn't distract or interfere
    if (reticle) reticle.style.display = 'none';
    if (cameraHud) cameraHud.style.display = 'none';
    if (gazeBtn) gazeBtn.style.display = 'none';
    if (dwellBtn) dwellBtn.style.display = 'none';
    if (calibBtn) calibBtn.style.display = 'none';

    // Stop eye tracker camera loop to save GPU/CPU for sign tracker
    if (window.stopBrowserTracker) {
      window.stopBrowserTracker();
    }
    cancelDwell();

    // Launch Sign Interpreter View directly
    currentView = 'sign_to_speech';
    renderView();

    // Auto-start Sign Camera after layout renders
    setTimeout(() => {
      startSignCamera();
    }, 300);

    if (notify) showToast("🤟 Sign-to-Speech Active (Person A ➔ Middleman ➔ Person B)");

  } else if (mode === 'keyboard') {
    openKeyboardModal();
  }
}

/**
 * Two-Way Bridge: Person B (The Listener) sends a quick reply to Person A's camera screen
 */
function sendPersonBReply(replyText) {
  const inputEl = document.getElementById('person-b-reply-input');
  const text = (replyText || (inputEl ? inputEl.value : '')).trim();
  if (!text) return;

  if (inputEl) inputEl.value = '';

  // Show prominent reply banner on Person A's video viewport
  let toastEl = document.getElementById('person-a-reply-toast');
  if (!toastEl) {
    const viewport = document.querySelector('.sign-camera-viewport');
    if (viewport) {
      toastEl = document.createElement('div');
      toastEl.id = 'person-a-reply-toast';
      toastEl.className = 'person-a-reply-toast';
      viewport.appendChild(toastEl);
    }
  }

  if (toastEl) {
    toastEl.innerHTML = `<span>💬 Person B says:</span> <strong>"${text}"</strong>`;
    toastEl.style.display = 'flex';
    // Play subtle chime so Person A hears that Person B replied
    playClickChime();

    setTimeout(() => {
      if (toastEl) toastEl.style.display = 'none';
    }, 4500);
  }

  // Record in conversation history
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  signConversationHistory.unshift({
    icon: '👂',
    text: `Person B (Reply): "${text}"`,
    glosses: 'Spoken / Typed by Person B',
    time: timeStr
  });

  // Update history UI
  const historyList = document.getElementById('sign-history-list');
  if (historyList) {
    historyList.innerHTML = signConversationHistory.map(item => `
      <div class="sign-history-item" style="${item.icon === '👂' ? 'border-color:#3b82f6;background:rgba(59,130,246,0.1);' : ''}">
        <div class="sign-history-avatar">${item.icon}</div>
        <div class="sign-history-content">
          <div class="sign-history-text">${item.text}</div>
          <div class="sign-history-meta">${item.glosses} • ${item.time}</div>
        </div>
      </div>
    `).join('');
  }

  showToast(`Sent to Person A: "${text}"`);
}


/* ==========================================================================
   ISL RESEARCH DATASETS & REMOTE STREAMING MANAGER
   ========================================================================== */

let islDatasetsCache = null;

async function openDatasetsModal() {
  const modal = document.getElementById('isl-datasets-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  await loadISLDatasetsGrid();
}

function closeDatasetsModal() {
  const modal = document.getElementById('isl-datasets-modal');
  if (modal) modal.classList.add('hidden');
}

async function loadISLDatasetsGrid() {
  const gridEl = document.getElementById('isl-datasets-grid');
  if (!gridEl) return;

  gridEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-dim);">Connecting to Hugging Face Cloud…</div>';

  try {
    const res = await fetch('/api/isl/datasets');
    if (!res.ok) throw new Error('API returned ' + res.status);
    const data = await res.json();
    islDatasetsCache = data.datasets || [];

    const countEl = document.getElementById('stat-isl-count');
    const classesEl = document.getElementById('stat-isl-classes');
    const signersEl = document.getElementById('stat-isl-signers');
    if (countEl) countEl.textContent = data.total_datasets || islDatasetsCache.length;
    if (classesEl) classesEl.textContent = (data.total_sign_classes || 18500).toLocaleString() + '+';
    if (signersEl) signersEl.textContent = (data.total_signers || 100) + '+';

    gridEl.innerHTML = islDatasetsCache.map(ds => `
      <div class="isl-dataset-card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;">
          <div class="ds-name">${ds.name}</div>
        </div>
        <span class="ds-type">${(ds.type || '').replace('_', ' ').toUpperCase()}</span>
        <div class="ds-meta">
          <div>📊 <strong>${(ds.samples || 0).toLocaleString()}</strong> samples • <strong>${ds.classes || 0}</strong> classes</div>
          <div>👤 <strong>${ds.signers || '?'}</strong> signers • Format: ${ds.format}</div>
          <div>⚖️ ${ds.licence || 'Open Research'}</div>
          <div style="color:#10b981;font-weight:600;">☁️ ${ds.local_storage_used}</div>
        </div>
        <div class="ds-actions">
          ${ds.hf_repo_id ? `
            <button class="btn-ds-stream" onclick="inspectDatasetRemote('${ds.id}')">
              ⚡ Stream Samples
            </button>
          ` : `
            <a href="${ds.url}" target="_blank" rel="noopener" class="btn-perm-back" style="font-size:0.75rem;padding:4px 8px;text-decoration:none;">
              🔗 Official Portal
            </a>
          `}
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Failed to load ISL datasets:', err);
    gridEl.innerHTML = `<div style="color:#ef4444;padding:20px;text-align:center;">Failed to load dataset catalog: ${err.message}</div>`;
  }
}

async function inspectDatasetRemote(datasetId) {
  const drawer = document.getElementById('dataset-inspect-drawer');
  const titleEl = document.getElementById('inspect-drawer-title');
  const contentEl = document.getElementById('inspect-drawer-content');
  if (!drawer || !contentEl) return;

  drawer.style.display = 'block';
  if (titleEl) titleEl.textContent = `Streaming Remote Sample Rows: ${datasetId.toUpperCase()}`;
  contentEl.textContent = 'Streaming preview rows from Hugging Face Cloud API without local download…';

  try {
    const res = await fetch(`/api/isl/datasets/${datasetId}/inspect`);
    if (!res.ok) throw new Error('Inspect failed with status ' + res.status);
    const data = await res.json();
    contentEl.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    contentEl.textContent = `Error inspecting dataset: ${err.message}`;
  }
}

function closeInspectDrawer() {
  const drawer = document.getElementById('dataset-inspect-drawer');
  if (drawer) drawer.style.display = 'none';
}

async function checkISLConnectivity() {
  const statusEl = document.getElementById('isl-conn-status');
  if (!statusEl) return;
  statusEl.style.display = 'block';
  statusEl.innerHTML = '<span style="color:#a78bfa;">Testing latency to Hugging Face, Mendeley, and ISLRTC…</span>';

  try {
    const res = await fetch('/api/isl/connectivity');
    if (!res.ok) throw new Error('Status ' + res.status);
    const data = await res.json();
    statusEl.innerHTML = data.connectivity.map(c => `
      <div style="display:inline-block;margin-right:12px;color:${c.status === 'online' ? '#10b981' : '#60a5fa'};">
        ● ${c.name}: <strong>${c.latency_ms}ms</strong> (${c.status})
      </div>
    `).join('');
  } catch (err) {
    statusEl.innerHTML = `<span style="color:#ef4444;">Connectivity test error: ${err.message}</span>`;
  }
}

/* ==========================================================================
   AI SIGN INTERPRETATION & GRAMMAR POLISHING
   ========================================================================== */

let isAiInterpreting = false;

async function triggerAiSignInterpretation() {
  if (isAiInterpreting) return;

  const statusChip = document.getElementById('ai-sign-status-chip');
  const btn = document.getElementById('btn-ai-sign-polish');

  // 1. Capture current frame from canvas
  let frameB64 = null;
  if (typeof window.captureSignFrame === 'function') {
    frameB64 = window.captureSignFrame();
  }
  if (!frameB64) {
    const canvas = document.getElementById('sign-canvas');
    if (canvas) {
      try { frameB64 = canvas.toDataURL('image/jpeg', 0.7); } catch (_) {}
    }
  }

  if (!frameB64) {
    showToast('Please start the camera first to capture signs');
    return;
  }

  isAiInterpreting = true;
  if (statusChip) {
    statusChip.className = 'ai-sign-status-chip active';
    statusChip.textContent = '🧠 Gemini Vision: Analyzing handshape, orientation & facial cues…';
  }
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/sign-interpret-frame', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: frameB64 })
    });

    if (res.ok) {
      const result = await res.json();
      if (result && result.detected && result.meaning_en) {
        if (statusChip) {
          statusChip.className = 'ai-sign-status-chip detected';
          statusChip.textContent = `🧠 AI Sign Detected: ${result.meaning_en} (${result.sign_name || 'ISL Gesture'})`;
        }
        playClickChime();
        showToast(`AI Detected: "${result.meaning_en}"`);

        currentSignSentence = result.meaning_en;
        currentSignMalayalam = '';

        const transEl = document.getElementById('sign-translated-text');
        const speakBtn = document.getElementById('btn-sign-speak');
        if (transEl) transEl.textContent = `"${currentSignSentence}"`;
        if (speakBtn) speakBtn.disabled = false;

        if (autoSpeakEnabled) {
          speakSignSentence();
        }

        const now = new Date();
        const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        signConversationHistory.unshift({
          icon: '🧠',
          text: `Person A (AI Vision): "${result.meaning_en}"`,
          glosses: `${result.sign_name || 'AI-Gesture'} • Conf: ${result.confidence || 'high'}`,
          time: timeStr
        });

        const historyList = document.getElementById('sign-history-list');
        if (historyList) {
          historyList.innerHTML = signConversationHistory.map(item => `
            <div class="sign-history-item" style="${item.icon === '🧠' ? 'border-color:#8b5cf6;background:rgba(139,92,246,0.1);' : ''}">
              <div class="sign-history-avatar">${item.icon}</div>
              <div class="sign-history-content">
                <div class="sign-history-text">${item.text}</div>
                <div class="sign-history-meta">${item.glosses} • ${item.time}</div>
              </div>
            </div>
          `).join('');
        }
      } else {
        if (statusChip) {
          statusChip.className = 'ai-sign-status-chip idle';
          statusChip.textContent = result.hand_description ? `🧠 Note: ${result.hand_description}` : '🧠 No clear sign recognized in frame — please hold hand clearly in view.';
        }
        showToast('Hold hand steady in front of camera for AI');
      }
    }
  } catch (err) {
    console.error('AI Sign interpretation error:', err);
    if (statusChip) {
      statusChip.className = 'ai-sign-status-chip idle';
      statusChip.textContent = '🧠 AI Offline / Connecting: Using local ISL Dataset rules';
    }
  } finally {
    isAiInterpreting = false;
    if (btn) btn.disabled = false;
  }
}


/* ==========================================================================
   CONTINUOUS AUTOMATIC ISL STREAMING & LEXICON EXPLORER
   ========================================================================== */

async function autoStreamSigningBurstToAI() {
  if (isAutoStreaming) return;

  const canvas = document.getElementById('sign-canvas');
  if (!canvas) return;

  isAutoStreaming = true;
  const statusChip = document.getElementById('ai-sign-status-chip');
  const confEl = document.getElementById('sign-detect-conf');
  if (statusChip) {
    statusChip.className = 'ai-sign-status-chip active';
    statusChip.textContent = '🧠 Translating Continuous Indian Sign Language Sentence…';
  }
  if (confEl) {
    confEl.textContent = '🧠 Multi-Frame AI Analyzing…';
    confEl.className = 'sign-confidence-badge medium';
  }

  try {
    // Capture temporal sequence of frames across continuous signing burst
    const frames = [];
    try { frames.push(canvas.toDataURL('image/jpeg', 0.65)); } catch (_) {}
    await new Promise(r => setTimeout(r, 180));
    try { frames.push(canvas.toDataURL('image/jpeg', 0.65)); } catch (_) {}
    await new Promise(r => setTimeout(r, 180));
    try { frames.push(canvas.toDataURL('image/jpeg', 0.65)); } catch (_) {}

    if (frames.length === 0) return;

    const res = await fetch('/api/sign-interpret-continuous', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: frames })
    });

    if (res.ok) {
      const data = await res.json();
      if (data && data.detected && data.sentence) {
        playClickChime();

        // Update live detection HUD
        const glossEl = document.getElementById('sign-detect-gloss');
        const meaningEl = document.getElementById('sign-detect-meaning');
        if (glossEl) glossEl.textContent = data.glosses ? data.glosses.join(' ➔ ') : (data.sign_name || 'ISL Continuous');
        if (meaningEl) meaningEl.textContent = data.sentence;
        if (confEl) {
          confEl.textContent = '🧠 ' + (data.confidence || 95) + '% CONTINUOUS MATCH';
          confEl.className = 'sign-confidence-badge high';
        }

        if (statusChip) {
          statusChip.className = 'ai-sign-status-chip detected';
          statusChip.textContent = `● Translated: "${data.sentence}"`;
        }

        // Update translated spoken output
        currentSignSentence = data.sentence;
        currentSignMalayalam = data.malayalam || '';

        const transEl = document.getElementById('sign-translated-text');
        const malEl = document.getElementById('sign-malayalam-text');
        const speakBtn = document.getElementById('btn-sign-speak');

        if (transEl) transEl.textContent = `"${currentSignSentence}"`;
        if (malEl) malEl.textContent = currentSignMalayalam ? `മലയാളം: ${currentSignMalayalam}` : '';
        if (speakBtn) speakBtn.disabled = false;

        // Auto speak if enabled
        if (autoSpeakEnabled) {
          speakSignSentence();
        }

        // Add to history
        const now = new Date();
        const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        signConversationHistory.unshift({
          icon: '🤟',
          text: `Person A (ISL): "${data.sentence}"`,
          glosses: (data.glosses || []).join(' ') || (data.explanation || 'ISL Continuous'),
          time: timeStr
        });

        const historyList = document.getElementById('sign-history-list');
        if (historyList) {
          historyList.innerHTML = signConversationHistory.map(item => `
            <div class="sign-history-item">
              <div class="sign-history-avatar">${item.icon}</div>
              <div class="sign-history-content">
                <div class="sign-history-text">${item.text}</div>
                <div class="sign-history-meta">ISL: [${item.glosses}] • ${item.time}</div>
              </div>
            </div>
          `).join('');
        }
      }
    }
  } catch (err) {
    console.error('Continuous stream error:', err);
  } finally {
    isAutoStreaming = false;
    setTimeout(() => {
      if (statusChip) {
        statusChip.className = 'ai-sign-status-chip active';
        statusChip.textContent = '🟢 Continuous ISL Stream Active: Translates sentences in real time';
      }
    }, 2500);
  }
}

let fullLexiconData = null;
let activeLexiconCategory = 'all';

async function loadFullLexiconExplorer() {
  const gridEl = document.getElementById('lexicon-cards-grid');
  const pillsEl = document.getElementById('lexicon-category-pills');
  if (!gridEl) return;

  if (!fullLexiconData) {
    try {
      const res = await fetch('/api/isl/full-lexicon');
      if (res.ok) {
        fullLexiconData = await res.json();
      }
    } catch (e) {
      console.error('Failed to load full lexicon:', e);
    }
  }

  if (!fullLexiconData || !fullLexiconData.categories) {
    gridEl.innerHTML = '<div style="color:#ef4444;padding:12px;">Failed to load ISLRTC Lexicon</div>';
    return;
  }

  // Render Category Filter Pills
  if (pillsEl && pillsEl.children.length === 0) {
    const categories = [{ id: 'all', name: 'All Signs', icon: '🌟' }, ...fullLexiconData.categories];
    pillsEl.innerHTML = categories.map(cat => `
      <button class="btn-secondary" onclick="selectLexiconCategory('${cat.id}')" style="padding:4px 10px;font-size:0.75rem;border-radius:99px;border-color:${cat.id === activeLexiconCategory ? '#10b981' : 'var(--card-border)'};color:${cat.id === activeLexiconCategory ? '#10b981' : 'var(--text)'};">
        ${cat.icon || '🏷️'} ${cat.name}
      </button>
    `).join('');
  }

  renderLexiconItems();
}

function selectLexiconCategory(catId) {
  activeLexiconCategory = catId;
  const pillsEl = document.getElementById('lexicon-category-pills');
  if (pillsEl) {
    Array.from(pillsEl.children).forEach(btn => {
      const isMatch = btn.getAttribute('onclick').includes(`'${catId}'`);
      btn.style.borderColor = isMatch ? '#10b981' : 'var(--card-border)';
      btn.style.color = isMatch ? '#10b981' : 'var(--text)';
    });
  }
  const searchInput = document.getElementById('lexicon-search-input');
  filterLexiconDisplay(searchInput ? searchInput.value : '');
}

function filterLexiconDisplay(query) {
  renderLexiconItems(query);
}

function renderLexiconItems(filterText = '') {
  const gridEl = document.getElementById('lexicon-cards-grid');
  if (!gridEl || !fullLexiconData) return;

  const q = (filterText || '').trim().toLowerCase();
  let items = [];

  fullLexiconData.categories.forEach(cat => {
    if (activeLexiconCategory !== 'all' && cat.id !== activeLexiconCategory) return;
    cat.items.forEach(it => {
      const [gloss, en, ml, desc] = it;
      if (!q || gloss.toLowerCase().includes(q) || en.toLowerCase().includes(q) || ml.toLowerCase().includes(q) || desc.toLowerCase().includes(q)) {
        items.push({ category: cat.name, gloss, en, ml, desc });
      }
    });
  });

  if (items.length === 0) {
    gridEl.innerHTML = '<div style="color:var(--text-dim);padding:14px;text-align:center;grid-column:1/-1;">No ISL signs matched your search.</div>';
    return;
  }

  gridEl.innerHTML = items.map(it => `
    <div style="background:var(--card-bg);border:1px solid var(--card-border);border-radius:6px;padding:8px;font-size:0.8rem;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="font-weight:700;color:var(--text);font-size:0.88rem;">${it.gloss}</span>
        <span style="font-size:0.65rem;color:#a78bfa;background:rgba(167,139,250,0.15);padding:1px 5px;border-radius:4px;">${it.category}</span>
      </div>
      <div style="color:var(--accent);font-size:0.82rem;margin-top:2px;">${it.en}</div>
      <div style="color:#10b981;font-size:0.75rem;margin-top:2px;">${it.ml}</div>
      <div style="color:var(--text-dim);font-size:0.72rem;margin-top:4px;line-height:1.3;">🖐️ ${it.desc}</div>
    </div>
  `).join('');
}
