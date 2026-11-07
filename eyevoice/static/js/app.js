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
  const bar = cardEl.querySelector('.dwell-progress-bar');
  const startTime = performance.now();

  function step(now) {
    if (activeDwellCard !== cardEl) return;
    const elapsed = now - startTime;
    const progress = Math.min(100, (elapsed / DWELL_TIME_MS) * 100);
    if (bar) bar.style.width = progress + '%';

    if (elapsed >= DWELL_TIME_MS) {
      // Dwell fired - click the card!
      if (bar) bar.style.width = '0%';
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
    const bar = activeDwellCard.querySelector('.dwell-progress-bar');
    if (bar) bar.style.width = '0%';
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

  // Map normalized (0..1) gaze coordinates to window dimensions
  const px = data.x * window.innerWidth;
  const py = data.y * window.innerHeight;

  reticle.style.left = px + 'px';
  reticle.style.top = py + 'px';

  // Find card directly under the eye gaze point
  const el = document.elementFromPoint(px, py);
  const card = el ? el.closest('.card') : null;

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
async function loadData() {
  try {
    const res = await fetch('/api/categories');
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

  if (currentView === 'home') {
    homeBtn.classList.add('active');
    breadcrumbCurrent.style.display = 'none';
    breadcrumbSep.style.display = 'none';
    renderHomeView(content);
  } else {
    homeBtn.classList.remove('active');
    breadcrumbCurrent.style.display = 'inline-block';
    breadcrumbSep.style.display = 'inline-block';
    breadcrumbCurrent.textContent = currentCategory.name;
    renderCategoryView(content);
  }

  // Update focusable elements for keyboard/gaze navigation
  updateFocusableGrid();
}

function renderHomeView(container) {
  const html = `
    <div class="cards-grid">
      ${appData.categories.map((cat, idx) => `
        <div class="card ${cat.is_external ? 'keyboard-card' : ''}" 
             data-index="${idx}"
             onmouseenter="startDwell(this)"
             onmouseleave="cancelDwell(this)"
             onclick="selectCategory('${cat.id}')">
          <div class="dwell-progress-bar"></div>
          ${cat.is_external ? '<span class="card-badge">TEAMMATE FEATURE</span>' : ''}
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

function goHome() {
  currentView = 'home';
  currentCategory = null;
  focusedIndex = 0;
  renderView();
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
  document.getElementById('keyboard-modal').classList.remove('hidden');
}

function closeKeyboardModal() {
  document.getElementById('keyboard-modal').classList.add('hidden');
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

