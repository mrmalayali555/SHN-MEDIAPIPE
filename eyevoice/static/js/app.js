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
const DWELL_TIME_MS = 800; // 0.8 seconds resting gaze to select
let dwellTimer = null;
let dwellAnimFrame = null;
let activeDwellCard = null;

function toggleDwellMode() {
  dwellEnabled = !dwellEnabled;
  const btn = document.getElementById('dwell-toggle-btn');
  if (btn) {
    btn.textContent = dwellEnabled ? '⏱️ Eye Dwell Click: ON (0.8s)' : '⏱️ Eye Dwell Click: OFF';
    btn.style.color = dwellEnabled ? 'var(--good)' : 'var(--text-muted)';
  }
  showToast(dwellEnabled ? "Eye Dwell auto-selection enabled" : "Eye Dwell selection disabled (use click/enter)");
}

function startDwell(cardEl) {
  if (!dwellEnabled || !cardEl) return;
  cancelDwell();

  activeDwellCard = cardEl;
  const hBar = cardEl.querySelector('.dwell-progress-bar');
  const vBar = cardEl.querySelector('.dwell-progress-bar-vertical');
  const startTime = performance.now();

  function step(now) {
    if (activeDwellCard !== cardEl) return;
    const elapsed = now - startTime;
    const progress = Math.min(100, (elapsed / DWELL_TIME_MS) * 100);
    if (hBar) hBar.style.width = progress + '%';
    if (vBar) vBar.style.height = progress + '%';

    if (elapsed >= DWELL_TIME_MS) {
      // Dwell fired - click the card!
      if (hBar) hBar.style.width = '0%';
      if (vBar) vBar.style.height = '0%';
      activeDwellCard = null;
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

  // Handle Voluntary Blink
  if (data.blink && blinkChip) {
    blinkChip.classList.add('active');
    blinkChip.textContent = 'BLINK!';
    if (reticle) reticle.classList.add('blinking');
    setTimeout(() => {
      blinkChip.classList.remove('active');
      blinkChip.textContent = 'Blink: Ready';
      if (reticle) reticle.classList.remove('blinking');
    }, 280);
  }

  if (!data.found || !reticle) {
    return;
  }

  // 1. Check Eye Gesture for BACK: Look Left -> Look Right -> Look Left
  checkEyeGestureBack(data.x);

  // 2. High-Accuracy Adaptive Smoothing Filter
  const targetX = data.x * window.innerWidth;
  const targetY = data.y * window.innerHeight;

  const dx = targetX - smoothX;
  const dy = targetY - smoothY;
  const dist = Math.hypot(dx, dy);

  // If movement is micro-jitter, keep smoothX, smoothY steady
  if (dist > DEADBAND_PX) {
    const alpha = Math.min(0.42, Math.max(0.14, dist / 320));
    smoothX += dx * alpha;
    smoothY += dy * alpha;
  }

  reticle.style.left = smoothX + 'px';
  reticle.style.top = smoothY + 'px';

  // 3. Magnetic Card Snapping (Sticky Focus prevents jitter while dwelling)
  let card = null;

  if (lastGazeCard && lastGazeCard.isConnected) {
    const rect = lastGazeCard.getBoundingClientRect();
    const inStickyZone = (
      smoothX >= rect.left - HYSTERESIS_MARGIN &&
      smoothX <= rect.right + HYSTERESIS_MARGIN &&
      smoothY >= rect.top - HYSTERESIS_MARGIN &&
      smoothY <= rect.bottom + HYSTERESIS_MARGIN
    );
    if (inStickyZone) {
      card = lastGazeCard;
    }
  }

  if (!card) {
    const el = document.elementFromPoint(smoothX, smoothY);
    card = el ? el.closest('.card') : null;
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

    // Voluntary Blink-to-Click Confirmation!
    if (data.blink) {
      cancelDwell(card);
      card.click();
      showToast("Blink Confirmed!");
    }
  } else {
    if (lastGazeCard) {
      lastGazeCard.classList.remove('focused');
      cancelDwell(lastGazeCard);
      lastGazeCard = null;
    }
  }
}

async function recenterGaze() {
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
// Initialization
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
  document.body.setAttribute('data-gaze', 'webcam');
  loadData();
  setupKeyboardNavigation();
  initSpeech();

  // If browser_tracker isn't loaded (e.g. offline), fallback to server stream if local
  setTimeout(() => {
    if (gazeSource === 'webcam' && (!window.isBrowserTrackerRunning || !window.isBrowserTrackerRunning())) {
      if (window.initBrowserTracker) {
        window.initBrowserTracker();
      } else if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        initGazeStream();
      }
    }
  }, 300);

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
        <div class="card ${cat.is_external ? 'keyboard-card' : ''} ${cat.is_isl ? 'isl-feature-card' : ''}" 
             data-index="${idx}"
             onmouseenter="startDwell(this)"
             onmouseleave="cancelDwell(this)"
             onclick="selectCategory('${cat.id}')">
          <div class="dwell-progress-bar"></div>
          ${cat.is_external ? '<span class="card-badge">TEAMMATE FEATURE</span>' : ''}
          ${cat.is_isl ? '<span class="card-badge isl-badge">⭐ MAJOR NEW FEATURE</span>' : ''}
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

