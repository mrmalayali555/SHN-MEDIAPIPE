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
// ============================================================================
let gazeSource = 'webcam'; // 'webcam' or 'mouse'
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
  const reticle = document.getElementById('gaze-reticle');
  
  if (btn) {
    if (gazeSource === 'webcam') {
      btn.textContent = '👁️ Gaze: WEBCAM LIVE';
      btn.classList.add('active-gaze');
      showToast("Switched to MediaPipe Webcam Eye Tracking");
    } else {
      btn.textContent = '🖱️ Gaze: MOUSE DEMO';
      btn.classList.remove('active-gaze');
      showToast("Switched to Mouse-Simulated Gaze");
    }
  }
}

function toggleHudVisibility() {
  const body = document.getElementById('hud-body');
  hudVisible = !hudVisible;
  if (body) {
    body.style.display = hudVisible ? 'flex' : 'none';
  }
}

// ============================================================================
// Initialization
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
  loadData();
  setupKeyboardNavigation();
  initSpeech();
  initGazeStream();
  
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
// Indian Sign Language (ISL) to Speech Controller (Major Feature)
// ============================================================================
function renderISLView(container) {
  const filteredSigns = islCurrentCategory === 'all'
    ? islSignsData
    : islSignsData.filter(s => s.category === islCurrentCategory);

  const activeCatObj = islCategoriesData.find(c => c.id === islCurrentCategory) || { name: 'All Signs', icon: '🌟' };

  let html = `
    <div class="isl-container">
      <!-- HEADER BANNER -->
      <div class="isl-header-banner">
        <div class="isl-header-left">
          <div class="isl-title-row">
            <h2><span>🤟</span> Sign Language to Speech (ISL)</h2>
            <span class="isl-tag-pill">RESEARCH-GRADE ISL</span>
          </div>
          <p class="isl-subtitle">Express through your eyes. Speak through your language.</p>
        </div>
        <div class="isl-header-badges">
          <div class="isl-legend-chip verified" title="Documented in Indian Sign Language Research and Training Centre Dictionary">
            <span>✓</span> ISLRTC Verified Lexicon
          </div>
          <div class="isl-legend-chip grammar" title="Samar Sinha (2018) Linguistic Grammar Analysis">
            <span>🧠</span> SOV &amp; Topic-Comment Syntax
          </div>
          <button class="btn-back" onclick="goHome()" onmouseenter="startDwell(this)" onmouseleave="cancelDwell(this)">
            <div class="dwell-progress-bar"></div>
            ⬅ Back to Dashboard
          </button>
        </div>
      </div>

      <!-- SIGN EXPRESSION BUILDER / COMPOSER CARD -->
      <div class="isl-composer-card">
        <div class="isl-composer-header">
          <div class="isl-composer-title">
            <span>📝</span> Sign Expression Composer
            <span style="font-size:0.8rem;color:var(--text-muted);font-weight:400;">(${islSequence.length} signs selected)</span>
          </div>
          <div class="isl-composer-meta">
            ${islInterpretedResult && islInterpretedResult.syntax_type ? '<span class="isl-syntax-badge">Syntax: ' + islInterpretedResult.syntax_type + '</span>' : ''}
          </div>
        </div>

        <!-- TOKENS STRIP -->
        <div class="isl-tokens-strip" id="isl-tokens-strip">
          ${islSequence.length === 0 ? `
            <div class="isl-empty-placeholder">
              <span>👁️</span> Look at any sign card below to select it. (Try: [PRO-1] ➔ [WATER] ➔ [WANT] or [HEAD] ➔ [PAIN] or [DOCTOR] ➔ [COME] ➔ [WHEN])
            </div>
          ` : islSequence.map((sign, idx) => `
            <div class="isl-token-chip" onclick="removeISLSign(${idx})" title="Click or dwell to remove '${sign.gloss}'">
              <span class="isl-token-icon">${sign.icon}</span>
              <span class="isl-token-gloss">${sign.gloss}</span>
              <button class="isl-token-remove" onclick="event.stopPropagation(); removeISLSign(${idx})" title="Remove sign">✕</button>
            </div>
            ${idx < islSequence.length - 1 ? '<span class="isl-arrow-sep">➔</span>' : ''}
          `).join('')}
        </div>

        <!-- LIVE LINGUISTIC TRANSLATION DISPLAY -->
        <div class="isl-translation-box">
          <div class="isl-translation-header">
            <span class="isl-translation-label">🗣️ Interpreted Natural English Speech:</span>
            ${islInterpretedResult && islInterpretedResult.confidence ? `
              <span style="font-size:0.78rem;color:#34d399;font-weight:700;">
                ✓ Linguistic Confidence: ${Math.round(islInterpretedResult.confidence * 100)}%
              </span>
            ` : ''}
          </div>
          <div class="isl-spoken-sentence" id="isl-live-sentence">
            ${islInterpretedResult && islInterpretedResult.sentence ? `
              <span>"${islInterpretedResult.sentence}"</span>
            ` : `
              <span class="isl-sentence-empty">Select signs below to synthesize natural speech...</span>
            `}
          </div>
        </div>

        <!-- COMPOSER ACTION BUTTONS -->
        <div class="isl-actions-row">
          <button class="btn-isl-speak" id="btn-isl-speak" 
                  ${!islInterpretedResult || !islInterpretedResult.sentence ? 'disabled' : ''}
                  onclick="confirmAndSpeakISL()"
                  onmouseenter="startDwell(this)" onmouseleave="cancelDwell(this)">
            <div class="dwell-progress-bar"></div>
            🔊 Confirm &amp; Speak Sentence
          </button>

          <button class="btn-isl-action" 
                  ${!islLastSpokenText ? 'disabled style="opacity:0.5;"' : ''}
                  onclick="replayISL()"
                  onmouseenter="startDwell(this)" onmouseleave="cancelDwell(this)"
                  title="Replay the last spoken sentence">
            <div class="dwell-progress-bar"></div>
            🔁 Replay Speech
          </button>

          <button class="btn-isl-action" 
                  ${islSequence.length === 0 ? 'disabled style="opacity:0.5;"' : ''}
                  onclick="undoISLSign()"
                  onmouseenter="startDwell(this)" onmouseleave="cancelDwell(this)"
                  title="Remove the most recently selected sign">
            <div class="dwell-progress-bar"></div>
            ↩️ Undo Last Sign
          </button>

          <button class="btn-isl-action danger" 
                  ${islSequence.length === 0 ? 'disabled style="opacity:0.5;"' : ''}
                  onclick="clearISLSequence()"
                  onmouseenter="startDwell(this)" onmouseleave="cancelDwell(this)"
                  title="Clear entire sequence">
            <div class="dwell-progress-bar"></div>
            🗑️ Clear Sequence
          </button>

          <button class="btn-isl-action" 
                  ${islSequence.length === 0 ? 'disabled style="opacity:0.5;"' : ''}
                  onclick="openISLReviewModal()"
                  onmouseenter="startDwell(this)" onmouseleave="cancelDwell(this)"
                  title="Inspect linguistic rules and 5 sign parameters">
            <div class="dwell-progress-bar"></div>
            🔍 Review Grammar Analysis
          </button>
        </div>
      </div>

      <!-- CATEGORY FILTER TABS -->
      <div class="isl-tabs-row">
        ${islCategoriesData.map(cat => `
          <button class="isl-tab-btn ${islCurrentCategory === cat.id ? 'active' : ''}" 
                  onclick="filterISLCategory('${cat.id}')"
                  onmouseenter="startDwell(this)" onmouseleave="cancelDwell(this)">
            <div class="dwell-progress-bar"></div>
            <span>${cat.icon}</span>
            <span>${cat.name}</span>
            <span class="isl-tab-badge">
              ${cat.id === 'all' ? islSignsData.length : islSignsData.filter(s => s.category === cat.id).length}
            </span>
          </button>
        `).join('')}
      </div>

      <!-- SIGN LIBRARY GRID -->
      <div class="cards-grid isl-signs-grid">
        <!-- FIRST CARD: BACK TO DASHBOARD FOR INSTANT EASY GAZE ESCAPE -->
        <div class="card option-card back-card" 
             data-index="back"
             onmouseenter="startDwell(this)"
             onmouseleave="cancelDwell(this)"
             onclick="goHome()">
          <div class="dwell-progress-bar"></div>
          <div class="card-icon">↩️</div>
          <div class="card-title">BACK TO DASHBOARD</div>
          <div class="card-desc">Look here or glance left to return</div>
        </div>

        <!-- SIGNS IN CURRENT CATEGORY -->
        ${filteredSigns.map((sign, idx) => `
          <div class="card isl-sign-card"
               data-sign-id="${sign.id}"
               data-index="${idx}"
               onmouseenter="startDwell(this)"
               onmouseleave="cancelDwell(this)"
               onclick="addISLSign('${sign.id}')">
            <div class="dwell-progress-bar"></div>
            <div class="isl-card-top">
              <span class="isl-card-icon">${sign.icon || '🤟'}</span>
              ${sign.is_verified ? '<span class="isl-verified-pill">✓ ISLRTC VERIFIED</span>' : '<span class="isl-verified-pill" style="border-color:#a855f7;color:#c084fc;">ASSISTIVE SYMBOL</span>'}
            </div>
            <div class="isl-card-gloss">${sign.gloss}</div>
            <div class="isl-card-meaning">"${sign.meaning_en}"</div>
            
            <!-- 5 SIGN PARAMETERS DISPLAY -->
            <div class="isl-card-params">
              <div class="isl-param-row">
                <span class="isl-param-name">🖐️ Hand:</span>
                <span class="isl-param-val">${sign.handshape}</span>
              </div>
              <div class="isl-param-row">
                <span class="isl-param-name">📍 Location:</span>
                <span class="isl-param-val">${sign.location}</span>
              </div>
              <div class="isl-param-row">
                <span class="isl-param-name">🔄 Motion:</span>
                <span class="isl-param-val">${sign.movement}</span>
              </div>
              <div class="isl-param-row">
                <span class="isl-param-name">😊 Face:</span>
                <span class="isl-param-val">${sign.non_manual}</span>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  container.innerHTML = html;
}

async function addISLSign(signId) {
  const sign = islSignsData.find(s => s.id === signId);
  if (!sign) return;
  islSequence.push(sign);
  showToast(`Added sign: ${sign.gloss}`);
  await updateISLInterpretation();
  renderView();
}

async function removeISLSign(index) {
  if (index >= 0 && index < islSequence.length) {
    const removed = islSequence.splice(index, 1)[0];
    showToast(`Removed: ${removed.gloss}`);
    await updateISLInterpretation();
    renderView();
  }
}

async function undoISLSign() {
  if (islSequence.length > 0) {
    const removed = islSequence.pop();
    showToast(`Removed: ${removed.gloss}`);
    await updateISLInterpretation();
    renderView();
  }
}

async function clearISLSequence() {
  islSequence = [];
  islInterpretedResult = null;
  clearMessage();
  showToast("Cleared sign sequence");
  renderView();
}

function filterISLCategory(catId) {
  islCurrentCategory = catId;
  renderView();
}

async function updateISLInterpretation() {
  if (islSequence.length === 0) {
    islInterpretedResult = null;
    clearMessage();
    return;
  }
  try {
    const res = await fetch('/api/isl/interpret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signs: islSequence.map(s => s.id) }),
    });
    if (res.ok) {
      islInterpretedResult = await res.json();
      setMessage(islInterpretedResult.sentence, '🤟');
    }
  } catch (err) {
    console.error("Interpretation error:", err);
    // fallback join
    const fallbackSentence = islSequence.map(s => s.meaning_en).join(' ') + '.';
    islInterpretedResult = {
      sentence: fallbackSentence.charAt(0).toUpperCase() + fallbackSentence.slice(1),
      syntax_type: 'Direct Translation Fallback',
      confidence: 0.7
    };
    setMessage(islInterpretedResult.sentence, '🤟');
  }
}

function confirmAndSpeakISL() {
  if (!islInterpretedResult || !islInterpretedResult.sentence) return;
  const sentence = islInterpretedResult.sentence;
  islLastSpokenText = sentence;

  speakText(sentence);
  postMessageToServer(sentence, "Sign Language (ISL)", Boolean(islInterpretedResult.is_emergency));
  showToast(`Spoke: "${sentence}"`);

  // Visual feedback pulse
  const liveEl = document.getElementById('isl-live-sentence');
  if (liveEl) {
    liveEl.style.transform = 'scale(1.04)';
    liveEl.style.color = '#34d399';
    setTimeout(() => {
      if (liveEl) {
        liveEl.style.transform = 'none';
        liveEl.style.color = '#ffffff';
      }
    }, 400);
  }
}

function replayISL() {
  if (islLastSpokenText) {
    speakText(islLastSpokenText);
    showToast(`Replaying: "${islLastSpokenText}"`);
  }
}

function openISLReviewModal() {
  if (!islInterpretedResult || islSequence.length === 0) {
    showToast("Select signs first to review grammar.");
    return;
  }

  const modal = document.getElementById('isl-review-modal');
  if (!modal) return;

  // 1. Glosses
  const glossesStrip = document.getElementById('isl-review-glosses');
  if (glossesStrip) {
    glossesStrip.innerHTML = islSequence.map(s => `
      <span class="isl-token-chip">
        <span>${s.icon}</span>
        <strong>${s.gloss}</strong>
      </span>
    `).join(' <span style="color:#6366f1;font-weight:800;align-self:center;">➔</span> ');
  }

  // 2. Table of 5 parameters
  const paramsTable = document.getElementById('isl-review-params-table');
  if (paramsTable) {
    paramsTable.innerHTML = `
      <table class="isl-review-table">
        <thead>
          <tr>
            <th>Sign</th>
            <th>Meaning</th>
            <th>🖐️ Handshape</th>
            <th>📍 Location</th>
            <th>🔄 Movement</th>
            <th>😊 Non-Manual</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          ${islSequence.map(s => `
            <tr>
              <td><strong>${s.icon} ${s.gloss}</strong></td>
              <td>${s.meaning_en}</td>
              <td>${s.handshape}</td>
              <td>${s.location}</td>
              <td>${s.movement}</td>
              <td>${s.non_manual}</td>
              <td style="color:#34d399;font-size:0.75rem;">${s.source}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  // 3. Syntactic Derivation
  const syntaxTypeEl = document.getElementById('isl-review-syntax-type');
  if (syntaxTypeEl) syntaxTypeEl.textContent = islInterpretedResult.syntax_type || 'ISL SOV / Topic-Comment';

  const nonmanualEl = document.getElementById('isl-review-nonmanual');
  if (nonmanualEl) {
    const nms = islSequence.map(s => s.non_manual).filter(Boolean);
    nonmanualEl.textContent = nms.length ? nms.join('; ') : 'Neutral';
  }

  const rulesEl = document.getElementById('isl-review-rules');
  if (rulesEl) {
    rulesEl.textContent = islInterpretedResult.is_question 
      ? 'ISL Sentence-final wh-interrogative with eyebrow furrow & head tilt'
      : (islInterpretedResult.is_negated
          ? 'Post-verbal negative particle with headshake non-manual'
          : 'Topic-Comment ordering transformed into natural English SVO syntax');
  }

  // 4. Final Spoken Sentence
  const finalSentenceEl = document.getElementById('isl-review-final-sentence');
  if (finalSentenceEl) finalSentenceEl.textContent = islInterpretedResult.sentence;

  modal.classList.remove('hidden');
}

function closeISLReviewModal() {
  const modal = document.getElementById('isl-review-modal');
  if (modal) modal.classList.add('hidden');
}

function confirmAndSpeakISLFromModal() {
  confirmAndSpeakISL();
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
  focusableElements = Array.from(document.querySelectorAll('.cards-grid .card'));
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

