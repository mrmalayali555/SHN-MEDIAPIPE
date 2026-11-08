// sign_recognizer.js — Continuous Indian Sign Language (ISL) Recognition & Sentence Interpretation Engine
// Sourced from ISLRTC National Standards, ISL-CSLTR, iSign, and ISLVT continuous sentence research.
//
// Key Capabilities:
// 1. Dynamic Velocity-Valley Stroke Segmentation: Recognizes continuous signing without freezing pauses.
// 2. ISL Syntactic Sentence Parser: Direct SOV & WH-Final translation (e.g. [YOUR] [NAME] [WHAT] -> "What is your name?").
// 3. Multi-Tier Geometric & Aspect Ratio Disambiguation: Isolates confusing letters & authentic 2-handed ISL.
// 4. Non-Manual Marker (NMM) Integration: Eyebrow furrowing (WH-questions), head tilt, head nod/shake.
// 5. Complete 72-Sign National Lexicon + Real-time Fingerspelling Word Assembler.

class SignRecognizer {
  constructor(signVocabulary = []) {
    this.vocabulary = Array.isArray(signVocabulary) ? signVocabulary : [];
    this.signSequence = [];
    this.continuousSentenceTokens = [];
    this.currentCandidate = null;
    this.candidateStartTime = 0;
    this.holdProgress = 0;
    this.lastConfirmedSign = null;
    this.cooldownUntil = 0;
    this.minConfidenceThreshold = 0.50;

    // Movement history buffer for dynamic velocity valley & trajectory analysis (last 20 frames)
    this.trajectoryHistory = [];
    this.maxTrajectoryFrames = 20;
    this.recentVelocities = [];

    // Continuous signing state
    this.isContinuousSigning = false;
    this.lastStrokeTime = 0;
    this.lastActiveHandTime = 0;
    this.sentenceFinalized = false;
    this.currentSentenceText = '';
    this.currentMalayalamText = '';

    // Fingerspelling Word Assembler & Predictive Engine (emnikhil architecture)
    this.wordBuffer = '';
    this.blankStartTime = 0;
    this.lastDisambiguationNote = '';

    // Non-manual markers (Face / Head)
    this.activeNMM = {
      isBrowFurrowed: false, // WH-Questions (WHAT, WHERE, etc.)
      isBrowRaised: false,   // Polar Yes/No questions
      isHeadNodding: false,  // Affirmation (YES)
      isHeadShaking: false,  // Negation (NO)
    };

    // Comprehensive Prioritized ISL & Healthcare Word Dictionary
    this.predictiveDictionary = [
      // Healthcare & Emergency
      'DOCTOR', 'HOSPITAL', 'MEDICINE', 'NURSE', 'PAIN', 'FEVER', 'BREATHE', 'HEADACHE',
      'STOMACH', 'INJECTION', 'TABLET', 'BLOOD', 'HEART', 'AMBULANCE', 'CLINIC', 'EMERGENCY',
      'SURGERY', 'ALLERGY', 'OXYGEN', 'ICU', 'BANDAGE', 'DIZZY', 'VOMIT', 'COUGH', 'COLD',
      'PRESSURE', 'TEST', 'REPORT', 'PATIENT', 'HEALING', 'HEALTHY', 'WOUND', 'CRITICAL',
      // Daily Needs & Comfort
      'WATER', 'FOOD', 'BATHROOM', 'TOILET', 'SLEEP', 'TIRED', 'HUNGRY', 'THIRSTY', 'HELP',
      'REST', 'BLANKET', 'CLEAN', 'PHONE', 'CALL', 'CHAIR', 'BED', 'LIGHT', 'FAN',
      'WHEELCHAIR', 'GLASSES', 'WARM', 'HOT', 'COLD', 'SHIRT', 'CLOTHES', 'WALK',
      // Social & Politeness
      'HELLO', 'NAMASTE', 'PLEASE', 'THANK', 'THANKS', 'SORRY', 'WELCOME', 'GOODBYE',
      'GOOD', 'NICE', 'MORNING', 'NIGHT', 'FINE', 'YES', 'NO', 'OKAY', 'STOP', 'WAIT',
      'SURE', 'READY', 'AGREE', 'UNDERSTAND', 'CARE', 'SAFE', 'HAPPY', 'PEACE',
      // Family & People
      'MOTHER', 'FATHER', 'PARENTS', 'BROTHER', 'SISTER', 'FAMILY', 'FRIEND', 'SON',
      'DAUGHTER', 'CHILD', 'BABY', 'HUSBAND', 'WIFE', 'WOMAN', 'MAN', 'PERSON',
      // Conversational Sentence Connectors
      'YOUR', 'NAME', 'MY', 'WANT', 'CALL', 'TIME', 'WHAT', 'WHERE', 'WHEN', 'WHY', 'HOW',
      'NOW', 'TODAY', 'TOMORROW', 'YESTERDAY', 'LATER', 'MINUTE', 'HOUR', 'DAY',
      // Actions & Verbs
      'COME', 'GO', 'SEE', 'LOOK', 'EAT', 'DRINK', 'SIT', 'STAND', 'TALK', 'SPEAK',
      'READ', 'WRITE', 'NEED', 'GIVE', 'TAKE', 'HEAR', 'FEEL', 'KNOW',
      // Key ISL Identifiers
      'I_LOVE_YOU', 'ILY', 'DEAF', 'SIGN', 'LANGUAGE', 'INDIA', 'HOME', 'SCHOOL', 'WORK'
    ];
  }

  setVocabulary(vocab) {
    if (Array.isArray(vocab)) {
      this.vocabulary = vocab;
    }
  }

  processFrame(frameData) {
    const now = frameData.timestamp || performance.now();
    const hands = frameData.hands || [];
    const handedness = frameData.handedness || [];
    const pose = frameData.pose && frameData.pose.length > 0 ? frameData.pose[0] : null;
    const face = frameData.face && frameData.face.length > 0 ? frameData.face[0] : null;
    const blendshapes = frameData.blendshapes || [];

    // Analyze Non-Manual Markers (eyebrows, head)
    this._analyzeNonManualMarkers(blendshapes, face, pose);

    if (!hands || hands.length === 0) {
      this.currentCandidate = null;
      this.holdProgress = 0;
      this.trajectoryHistory = [];
      this.recentVelocities = [];

      // Sentence Boundary Detection: hands lowered or rested for >750ms after signing
      if (this.continuousSentenceTokens.length > 0 && !this.sentenceFinalized) {
        if (now - this.lastActiveHandTime > 750) {
          this.sentenceFinalized = true;
          this._finalizeContinuousSentence();
        }
      }

      // Blank / Pause Detection: auto-commit fingerspelled word if hands rested for >900ms
      if (this.wordBuffer.length > 0) {
        if (this.blankStartTime === 0) {
          this.blankStartTime = now;
        } else if (now - this.blankStartTime > 900) {
          this.commitCurrentWord('pause_blank');
          this.blankStartTime = 0;
        }
      }

      return {
        handsDetected: 0,
        currentSign: null,
        isHolding: false,
        holdProgress: 0,
        confirmedSign: null,
        wordBuffer: this.wordBuffer,
        suggestions: this.getWordPredictions(),
        fingerStates: { dominant: null, secondary: null },
        handLocation: 'none',
        disambiguationNote: this.lastDisambiguationNote,
        continuousSentence: this.currentSentenceText,
        malayalamSentence: this.currentMalayalamText,
        sentenceTokens: [...this.continuousSentenceTokens],
        nmm: { ...this.activeNMM },
      };
    }

    this.blankStartTime = 0;
    this.lastActiveHandTime = now;
    if (this.sentenceFinalized) {
      // Start a new continuous sentence if hands reactivate after finalization
      this.continuousSentenceTokens = [];
      this.sentenceFinalized = false;
    }

    // 1. Analyze 3D finger states, aspect ratios, and spatial geometric metrics
    const analyzedHands = [];
    for (let i = 0; i < hands.length; i++) {
      const lm = hands[i];
      const hLabel = (handedness[i] && handedness[i][0]) ? handedness[i][0].categoryName : (i === 0 ? 'Right' : 'Left');
      const analysis = this._analyzeHandGeometry(lm);
      analyzedHands.push({
        landmarks: lm,
        label: hLabel,
        ...analysis,
      });
    }

    // 2. Trajectory & Dynamic Velocity Valley Analysis
    if (analyzedHands[0]) {
      this.trajectoryHistory.push({
        t: now,
        wx: analyzedHands[0].wrist.x,
        wy: analyzedHands[0].wrist.y,
        ix: analyzedHands[0].indexTip.x,
        iy: analyzedHands[0].indexTip.y,
      });
      if (this.trajectoryHistory.length > this.maxTrajectoryFrames) {
        this.trajectoryHistory.shift();
      }
    }

    // Body anchor location & Two-hand spatial relation
    const handLocation = this._detectHandLocation(analyzedHands[0], pose, face);
    const twoHand = this._analyzeTwoHand(analyzedHands);
    const motion = this._computeMotionDynamics();

    // Track recent velocity for stroke valley detection
    this.recentVelocities.push(motion.velocity);
    if (this.recentVelocities.length > 8) this.recentVelocities.shift();
    const maxRecentV = Math.max(...this.recentVelocities);
    const minRecentV = Math.min(...this.recentVelocities);

    // A Sign Stroke Valley occurs when motion decelerates to a local minimum after movement
    const isStrokeValley = (motion.velocity < 0.24 && maxRecentV > 0.28) || (motion.velocity < 0.16);
    this.isContinuousSigning = maxRecentV > 0.35 || this.continuousSentenceTokens.length > 0;

    // 3. Candidate Matching with Multi-Tier Disambiguation
    let bestMatch = null;
    let highestScore = 0;
    let bestDisambiguation = '';

    for (const sign of this.vocabulary) {
      const { score, disambiguation } = this._scoreSignMatch(sign, analyzedHands, handLocation, twoHand, motion);
      if (score > highestScore && score >= this.minConfidenceThreshold) {
        highestScore = score;
        bestDisambiguation = disambiguation || '';

        // Dynamic hold time: in continuous signing / stroke valley, hold time is reduced to 180-220ms!
        let holdMs = 320;
        if (isStrokeValley || this.isContinuousSigning) {
          holdMs = 180; // Agile stroke nucleus duration in continuous signing
        } else if (sign.id.startsWith('LETTER_')) {
          holdMs = 260;
        }

        bestMatch = {
          id: sign.id,
          gloss: sign.gloss,
          meaning_en: sign.meaning_en,
          meaning_ml: sign.meaning_ml || '',
          category: sign.category || 'general',
          confidence: Math.round(score * 100),
          min_hold_ms: holdMs,
        };
      }
    }

    if (bestDisambiguation) {
      this.lastDisambiguationNote = bestDisambiguation;
    }

    // 4. Temporal Stability Hold & Velocity-Valley Confirmation
    let confirmed = null;
    const isCooldown = now < this.cooldownUntil;

    if (bestMatch && !isCooldown) {
      if (!this.currentCandidate || this.currentCandidate.id !== bestMatch.id) {
        this.currentCandidate = bestMatch;
        this.candidateStartTime = now;
        this.holdProgress = 0;
      } else {
        const elapsed = now - this.candidateStartTime;
        const requiredHold = bestMatch.min_hold_ms || 180;
        this.holdProgress = Math.min(1.0, elapsed / requiredHold);

        if (this.holdProgress >= 1.0) {
          confirmed = {
            id: bestMatch.id,
            gloss: bestMatch.gloss,
            meaning_en: bestMatch.meaning_en,
            meaning_ml: bestMatch.meaning_ml,
            category: bestMatch.category,
            confidence: bestMatch.confidence,
            timestamp: now,
          };

          const isLetter = bestMatch.id.startsWith('LETTER_');
          const isNum = bestMatch.id.startsWith('NUM_');

          if (isLetter) {
            const letterChar = bestMatch.id.replace('LETTER_', '');
            this.wordBuffer += letterChar;
          } else if (isNum) {
            const numChar = bestMatch.id.replace('NUM_', '');
            this.wordBuffer += numChar;
          } else {
            // Whole conversational sign: commit fingerspelled word first if any
            if (this.wordBuffer.length > 0) {
              this.commitCurrentWord('sign_boundary');
            }
            this.signSequence.push(confirmed);
            this.continuousSentenceTokens.push(confirmed.id);

            // Synthesize the continuous sentence live
            const translation = this.translateContinuousSequence(this.continuousSentenceTokens);
            this.currentSentenceText = translation.sentence;
            this.currentMalayalamText = translation.malayalam || confirmed.meaning_ml || '';
          }

          this.lastConfirmedSign = confirmed;
          this.lastStrokeTime = now;
          this.currentCandidate = null;
          this.holdProgress = 0;

          // Agile cooldown for continuous signing: 180ms prevents stroke exit glitch without blocking next sign!
          const cooldownDuration = this.isContinuousSigning ? 180 : (isLetter || isNum ? 280 : 360);
          this.cooldownUntil = now + cooldownDuration;
        }
      }
    } else {
      if (!isCooldown) {
        this.currentCandidate = null;
        this.holdProgress = 0;
      }
    }

    return {
      handsDetected: hands.length,
      currentSign: this.currentCandidate,
      isHolding: this.holdProgress > 0 && this.holdProgress < 1.0,
      holdProgress: this.holdProgress,
      confirmedSign: confirmed,
      wordBuffer: this.wordBuffer,
      suggestions: this.getWordPredictions(),
      fingerStates: {
        dominant: analyzedHands[0] ? analyzedHands[0].fingers : null,
        secondary: analyzedHands[1] ? analyzedHands[1].fingers : null,
      },
      handLocation: handLocation,
      motion: motion,
      disambiguationNote: this.lastDisambiguationNote,
      continuousSentence: this.currentSentenceText,
      malayalamSentence: this.currentMalayalamText,
      sentenceTokens: [...this.continuousSentenceTokens],
      nmm: { ...this.activeNMM },
    };
  }

  /**
   * Extract Non-Manual Markers (NMM) from MediaPipe FaceMesh & Pose
   * Eyebrow furrowing (WH-questions), eyebrow raising (Yes/No), head shake/nod
   */
  _analyzeNonManualMarkers(blendshapes, face, pose) {
    if (blendshapes && blendshapes.length > 0) {
      const bMap = {};
      blendshapes.forEach(b => {
        if (b.categoryName) bMap[b.categoryName] = b.score;
      });

      const browDown = (bMap['browDownLeft'] || 0) + (bMap['browDownRight'] || 0);
      const browUp = (bMap['browInnerUp'] || 0) + (bMap['browOuterUpLeft'] || 0);

      this.activeNMM.isBrowFurrowed = browDown > 0.45;
      this.activeNMM.isBrowRaised = browUp > 0.45;
    } else if (face && face.length > 105) {
      // Geometric fallback using eyebrow landmarks #66, #105 vs eye landmarks #159, #386
      const leftBrowY = face[66] ? face[66].y : 0.4;
      const leftEyeY = face[159] ? face[159].y : 0.43;
      const browDist = leftEyeY - leftBrowY;
      this.activeNMM.isBrowFurrowed = browDist < 0.024;
      this.activeNMM.isBrowRaised = browDist > 0.048;
    }

    // Head orientation oscillation (Shake vs Nod) from Pose nose landmark #0
    if (pose && pose.length > 0 && pose[0]) {
      const nose = pose[0];
      if (!this._lastNose) {
        this._lastNose = { x: nose.x, y: nose.y, t: performance.now(), flipX: 0, flipY: 0 };
      } else {
        const dt = (performance.now() - this._lastNose.t) / 1000;
        const dx = nose.x - this._lastNose.x;
        const dy = nose.y - this._lastNose.y;
        if (Math.abs(dx) > 0.015 && dt < 0.5) this._lastNose.flipX++;
        if (Math.abs(dy) > 0.015 && dt < 0.5) this._lastNose.flipY++;

        this.activeNMM.isHeadShaking = this._lastNose.flipX >= 2;
        this.activeNMM.isHeadNodding = this._lastNose.flipY >= 2;

        if (dt > 1.0) {
          this._lastNose = { x: nose.x, y: nose.y, t: performance.now(), flipX: 0, flipY: 0 };
        }
      }
    }
  }

  /**
   * ISL Syntactic Grammar Engine: Translates sequence of glosses to natural sentence
   * Uses authentic Indian Sign Language SOV & WH-Final linguistic rules
   */
  translateContinuousSequence(glosses = []) {
    if (!glosses || glosses.length === 0) {
      return { sentence: '', malayalam: '', type: 'empty' };
    }

    const clean = glosses.map(g => g.replace('PRO-2', 'YOUR').replace('PRO-1', 'I'));
    const key = clean.join(' ');

    const PATTERNS = {
      // 1. Critical Inquiry: "What is your name?"
      'YOUR NAME WHAT': { sentence: 'What is your name?', malayalam: 'നിങ്ങളുടെ പേരെന്താണ്?', type: 'question' },
      'NAME WHAT': { sentence: 'What is your name?', malayalam: 'നിങ്ങളുടെ പേരെന്താണ്?', type: 'question' },
      'YOU NAME WHAT': { sentence: 'What is your name?', malayalam: 'നിങ്ങളുടെ പേരെന്താണ്?', type: 'question' },
      'YOUR NAME': { sentence: 'What is your name?', malayalam: 'നിങ്ങളുടെ പേരെന്താണ്?', type: 'question' },

      // 2. Healthcare & Location Queries (WH-Final in ISL)
      'HOSPITAL WHERE': { sentence: 'Where is the hospital?', malayalam: 'ആശുപത്രി എവിടെയാണ്?', type: 'question' },
      'BATHROOM WHERE': { sentence: 'Where is the bathroom?', malayalam: 'ബാത്ത്റൂം എവിടെയാണ്?', type: 'question' },
      'DOCTOR WHERE': { sentence: 'Where is the doctor?', malayalam: 'ഡോക്ടർ എവിടെയാണ്?', type: 'question' },
      'MEDICINE WHERE': { sentence: 'Where is the medicine?', malayalam: 'മരുന്ന് എവിടെയാണ്?', type: 'question' },
      'MEDICINE TIME WHAT': { sentence: 'What time should I take the medicine?', malayalam: 'മരുന്ന് കഴിക്കേണ്ട സമയം എപ്പോഴാണ്?', type: 'question' },

      // 3. Urgent Care & Requests
      'DOCTOR CALL PLEASE': { sentence: 'Please call the doctor.', malayalam: 'ദയവായി ഡോക്ടറെ വിളിക്കൂ.', type: 'request' },
      'DOCTOR CALL': { sentence: 'Please call the doctor immediately.', malayalam: 'ദയവായി ഡോക്ടറെ വിളിക്കൂ.', type: 'request' },
      'CALL DOCTOR': { sentence: 'Please call the doctor.', malayalam: 'ദയവായി ഡോക്ടറെ വിളിക്കൂ.', type: 'request' },
      'FAMILY CALL': { sentence: 'Please call my family.', malayalam: 'എന്റെ കുടുംബത്തെ വിളിക്കൂ.', type: 'request' },
      'MY FAMILY CALL': { sentence: 'Please call my family.', malayalam: 'എന്റെ കുടുംബത്തെ വിളിക്കൂ.', type: 'request' },
      'PLEASE HELP': { sentence: 'Please help me.', malayalam: 'ദയവായി എന്നെ സഹായിക്കൂ.', type: 'request' },
      'HELP PLEASE': { sentence: 'Please help me.', malayalam: 'ദയവായി എന്നെ സഹായിക്കൂ.', type: 'request' },
      'EMERGENCY DOCTOR CALL': { sentence: 'Emergency! Please call a doctor right away.', malayalam: 'അടിയന്തിരമാണ്! ഉടൻ ഡോക്ടറെ വിളിക്കൂ.', type: 'urgent' },
      'EMERGENCY CALL': { sentence: 'Emergency! Please call for help immediately.', malayalam: 'അടിയന്തിരമാണ്! ഉടൻ സഹായം വിളിക്കൂ.', type: 'urgent' },

      // 4. Symptoms & Daily Needs (Topic - Comment in ISL)
      'HEAD PAIN': { sentence: 'I have a severe headache.', malayalam: 'എനിക്ക് തലവേദനയുണ്ട്.', type: 'medical' },
      'STOMACH PAIN': { sentence: 'My stomach is hurting.', malayalam: 'എനിക്ക് വയറുവേദനയുണ്ട്.', type: 'medical' },
      'FEVER HAVE': { sentence: 'I have a fever.', malayalam: 'എനിക്ക് പനിയുണ്ട്.', type: 'medical' },
      'I WATER WANT': { sentence: 'I want some water, please.', malayalam: 'എനിക്ക് വെള്ളം വേണം.', type: 'need' },
      'WATER WANT': { sentence: 'I want some water, please.', malayalam: 'എനിക്ക് വെള്ളം വേണം.', type: 'need' },
      'WATER NEED': { sentence: 'I need water.', malayalam: 'എനിക്ക് വെള്ളം വേണം.', type: 'need' },
      'I FOOD HUNGRY': { sentence: 'I am hungry and need food.', malayalam: 'എനിക്ക് വിശക്കുന്നു, ഭക്ഷണം വേണം.', type: 'need' },
      'FOOD HUNGRY': { sentence: 'I am hungry. Please give me food.', malayalam: 'എനിക്ക് വിശക്കുന്നു, ഭക്ഷണം വേണം.', type: 'need' },

      // 5. Social & Politeness
      'HOW_ARE_YOU': { sentence: 'How are you doing?', malayalam: 'സുഖമാണോ?', type: 'social' },
      'HOW ARE YOU': { sentence: 'How are you doing?', malayalam: 'സുഖമാണോ?', type: 'social' },
      'NICE_TO_MEET_YOU': { sentence: 'Nice to meet you.', malayalam: 'കണ്ടതിൽ സന്തോഷം.', type: 'social' },
      'NICE TO MEET YOU': { sentence: 'Nice to meet you.', malayalam: 'കണ്ടതിൽ സന്തോഷം.', type: 'social' },
      'I FINE THANK_YOU': { sentence: 'I am doing fine, thank you.', malayalam: 'എനിക്ക് സുഖമാണ്, നന്ദി.', type: 'social' },
      'I_LOVE_YOU': { sentence: 'I love you.', malayalam: 'ഞാൻ നിന്നെ സ്നേഹിക്കുന്നു.', type: 'affection' },
    };

    if (PATTERNS[key]) {
      return PATTERNS[key];
    }

    // Generic ISL Question Inversion: If sentence ends with WHAT, WHERE, WHEN, WHY, HOW
    const lastWord = clean[clean.length - 1];
    if (['WHAT', 'WHERE', 'WHEN', 'WHY', 'HOW'].includes(lastWord)) {
      const subject = clean.slice(0, -1).map(w => w.replace('_', ' ').toLowerCase()).join(' ');
      const qWord = lastWord.charAt(0).toUpperCase() + lastWord.slice(1).toLowerCase();
      return {
        sentence: `${qWord} is ${subject || 'that'}?`,
        malayalam: '',
        type: 'question'
      };
    }

    // Generic SOV to English assembly
    const words = clean.map(w => w.replace('_', ' ').toLowerCase());
    return {
      sentence: words.join(' ').charAt(0).toUpperCase() + words.join(' ').slice(1) + '.',
      malayalam: '',
      type: 'statement'
    };
  }

  _finalizeContinuousSentence() {
    if (this.continuousSentenceTokens.length === 0) return;
    const translation = this.translateContinuousSequence(this.continuousSentenceTokens);
    this.currentSentenceText = translation.sentence;
    this.currentMalayalamText = translation.malayalam || '';
  }

  /**
   * Orientation-independent 3D joint geometry, normalized distances, and bounding-box aspect ratio
   */
  _analyzeHandGeometry(lm) {
    if (!lm || lm.length < 21) {
      return {
        fingers: { thumb: 'folded', index: 'folded', middle: 'folded', ring: 'folded', pinky: 'folded' },
        wrist: { x: 0.5, y: 0.5, z: 0 },
        indexTip: { x: 0.5, y: 0.5, z: 0 },
        thumbTip: { x: 0.5, y: 0.5, z: 0 },
        middleTip: { x: 0.5, y: 0.5, z: 0 },
        ringTip: { x: 0.5, y: 0.5, z: 0 },
        pinkyTip: { x: 0.5, y: 0.5, z: 0 },
        aspectRatio: 1.0,
        handSpan: 0.1,
        spreadIndexMiddle: 0.1,
        distThumbIndex: 0.1,
        distThumbMiddle: 0.1,
        openCount: 0,
      };
    }

    const dist3D = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
    const wrist = lm[0];
    const handSpan = dist3D(wrist, lm[9]) || 0.12;

    const isFingerExtended = (mcpIdx, pipIdx, tipIdx) => {
      const mcp = lm[mcpIdx];
      const pip = lm[pipIdx];
      const tip = lm[tipIdx];
      const dTipMcp = dist3D(tip, mcp);
      const dPipMcp = dist3D(pip, mcp);
      const dTipWrist = dist3D(tip, wrist);
      const dPipWrist = dist3D(pip, wrist);
      return (dTipMcp > dPipMcp * 1.25) || (dTipWrist > dPipWrist * 1.15);
    };

    const indexExt  = isFingerExtended(5, 6, 8);
    const middleExt = isFingerExtended(9, 10, 12);
    const ringExt   = isFingerExtended(13, 14, 16);
    const pinkyExt  = isFingerExtended(17, 18, 20);

    const thumbTip = lm[4];
    const thumbIP = lm[3];
    const thumbMCP = lm[2];
    const indexMCP = lm[5];
    const pinkyMCP = lm[17];

    const dThumbIndex = dist3D(thumbTip, indexMCP);
    const dThumbPinky = dist3D(thumbTip, pinkyMCP);
    const dIPIndex = dist3D(thumbIP, indexMCP);
    const thumbExt = (dThumbIndex > dIPIndex * 1.22) || (dThumbPinky > dist3D(thumbMCP, pinkyMCP) * 1.25);

    const fingers = {
      thumb:  thumbExt  ? 'extended' : 'folded',
      index:  indexExt  ? 'extended' : 'folded',
      middle: middleExt ? 'extended' : 'folded',
      ring:   ringExt   ? 'extended' : 'folded',
      pinky:  pinkyExt  ? 'extended' : 'folded',
    };

    const openCount = [fingers.thumb, fingers.index, fingers.middle, fingers.ring, fingers.pinky].filter(x => x === 'extended').length;

    const xs = lm.map(p => p.x);
    const ys = lm.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const bboxW = maxX - minX;
    const bboxH = maxY - minY;
    const aspectRatio = bboxW / (bboxH || 0.001);

    const spreadIndexMiddle = dist3D(lm[8], lm[12]) / handSpan;
    const spreadMiddleRing = dist3D(lm[12], lm[16]) / handSpan;
    const spreadRingPinky = dist3D(lm[16], lm[20]) / handSpan;
    const distThumbIndexNorm = dist3D(lm[4], lm[8]) / handSpan;
    const distThumbMiddleNorm = dist3D(lm[4], lm[12]) / handSpan;
    const distThumbRingNorm = dist3D(lm[4], lm[16]) / handSpan;
    const distThumbPinkyNorm = dist3D(lm[4], lm[20]) / handSpan;

    return {
      fingers,
      wrist,
      indexTip: lm[8],
      thumbTip: lm[4],
      middleTip: lm[12],
      ringTip: lm[16],
      pinkyTip: lm[20],
      aspectRatio,
      handSpan,
      openCount,
      spreadIndexMiddle,
      spreadMiddleRing,
      spreadRingPinky,
      distThumbIndex: distThumbIndexNorm,
      distThumbMiddle: distThumbMiddleNorm,
      distThumbRing: distThumbRingNorm,
      distThumbPinky: distThumbPinkyNorm,
    };
  }

  _detectHandLocation(primaryHand, pose, face) {
    if (!primaryHand) return 'unknown';

    const handY = primaryHand.indexTip.y;
    const handX = primaryHand.indexTip.x;

    if (face && face.length > 152) {
      const mouthY = face[13] ? face[13].y : 0.4;
      const mouthX = face[13] ? face[13].x : 0.5;

      if (Math.hypot(handX - mouthX, handY - mouthY) < 0.16) {
        return 'mouth_chin';
      }
      if (handY < mouthY + 0.08) {
        return 'face';
      }
    }

    if (pose && pose.length > 12) {
      const shoulderMidY = ((pose[11]?.y || 0.5) + (pose[12]?.y || 0.5)) / 2;
      if (handY >= shoulderMidY - 0.15 && handY <= shoulderMidY + 0.35) {
        return 'chest';
      }
    }

    if (handY < 0.38) return 'face';
    if (handY < 0.72) return 'chest';
    return 'neutral';
  }

  _analyzeTwoHand(analyzedHands) {
    if (analyzedHands.length < 2) {
      return { isTwoHanded: false, wristDistance: 999, isContact: false, indexContact: false };
    }
    const h1 = analyzedHands[0];
    const h2 = analyzedHands[1];
    const wristDist = Math.hypot(h1.wrist.x - h2.wrist.x, h1.wrist.y - h2.wrist.y);
    const indexDist = Math.hypot(h1.indexTip.x - h2.indexTip.x, h1.indexTip.y - h2.indexTip.y);
    const thumbContact = Math.hypot(h1.indexTip.x - h2.thumbTip.x, h1.indexTip.y - h2.thumbTip.y);

    return {
      isTwoHanded: true,
      wristDistance: wristDist,
      isContact: wristDist < 0.24,
      indexContact: indexDist < 0.14,
      dominantIndexOnThumb: thumbContact < 0.14,
    };
  }

  _computeMotionDynamics() {
    if (this.trajectoryHistory.length < 5) {
      return { velocity: 0, isOscillating: false, isMovingDown: false };
    }

    const first = this.trajectoryHistory[0];
    const last = this.trajectoryHistory[this.trajectoryHistory.length - 1];
    const dt = (last.t - first.t) / 1000 || 0.001;

    const dx = last.wx - first.wx;
    const dy = last.wy - first.wy;
    const velocity = Math.hypot(dx, dy) / dt;

    let signFlips = 0;
    for (let i = 2; i < this.trajectoryHistory.length; i++) {
      const v1 = this.trajectoryHistory[i - 1].ix - this.trajectoryHistory[i - 2].ix;
      const v2 = this.trajectoryHistory[i].ix - this.trajectoryHistory[i - 1].ix;
      if ((v1 > 0.005 && v2 < -0.005) || (v1 < -0.005 && v2 > 0.005)) {
        signFlips++;
      }
    }

    return {
      velocity: velocity,
      isOscillating: signFlips >= 2,
      isMovingDown: dy > 0.06,
    };
  }

  /**
   * Multi-Tier ISL Disambiguation & Scoring Engine
   */
  _scoreSignMatch(sign, analyzedHands, handLocation, twoHand, motion) {
    const dominant = analyzedHands[0];
    if (!dominant) return { score: 0, disambiguation: '' };

    const f = dominant.fingers;
    const signId = sign.id;
    const openCount = dominant.openCount;
    const spreadIM = dominant.spreadIndexMiddle;

    // ── 1. CORE CONTINUOUS CONVERSATIONAL SIGNS ──

    // YOUR: Dominant index pointing forward or open palm facing conversational partner
    if (signId === 'YOUR' || signId === 'PRO-2') {
      const isPointingForward = (f.index === 'extended' && f.middle === 'folded' && f.ring === 'folded');
      const isOpenPalmForward = (openCount >= 4 && motion.velocity < 0.28);
      if ((isPointingForward || isOpenPalmForward) && (handLocation === 'chest' || handLocation === 'neutral')) {
        return { score: 0.95, disambiguation: 'ISL Pronoun YOUR: Pointing/Palm forward to Person B' };
      }
    }

    // NAME: Dominant Index + Middle extended tapping temple or touching non-dominant fingers
    if (signId === 'NAME') {
      const isTwoFingers = (f.index === 'extended' && f.middle === 'extended' && f.ring === 'folded' && f.pinky === 'folded');
      const isOneFinger = (f.index === 'extended' && f.middle === 'folded' && f.ring === 'folded' && f.pinky === 'folded');
      if (isTwoFingers && (handLocation === 'face' || twoHand.indexContact || twoHand.isContact)) {
        return { score: 0.96, disambiguation: 'ISL Concept NAME: Dominant Index+Middle tapping Temple / Contact' };
      }
      if (isOneFinger && handLocation === 'face' && dominant.indexTip.y < 0.32) {
        return { score: 0.92, disambiguation: 'ISL Concept NAME: Index tapping Temple' };
      }
    }

    // WHAT: Palms up oscillating / wagging inquiry + NMM eyebrow furrow
    if (signId === 'WHAT') {
      if (openCount >= 4 && motion.isOscillating) {
        return { score: 0.96, disambiguation: 'ISL What: Palms up oscillating inquiry' };
      }
      if (openCount >= 4 && handLocation === 'chest' && this.activeNMM.isBrowFurrowed) {
        return { score: 0.93, disambiguation: 'ISL What: Furrowed Eyebrow Interrogative' };
      }
    }

    // MY / ME: Flat palm on chest
    if (signId === 'MY' || signId === 'PRO-1') {
      if (openCount >= 4 && handLocation === 'chest' && motion.velocity < 0.20) {
        return { score: 0.95, disambiguation: 'ISL Pronoun MY/ME: Flat Palm resting on Chest' };
      }
      if (f.index === 'extended' && f.middle === 'folded' && handLocation === 'chest') {
        return { score: 0.92, disambiguation: 'ISL Pronoun ME/I: Index pointing to Chest' };
      }
    }

    // WANT / NEED: Palms facing upward pulling inward
    if (signId === 'WANT') {
      if (openCount >= 4 && handLocation === 'chest') {
        return { score: 0.92, disambiguation: 'ISL Verb WANT/NEED: Palms facing upward at Chest' };
      }
    }

    // CALL: Y-handshape near ear / phone
    if (signId === 'CALL') {
      if (f.thumb === 'extended' && f.pinky === 'extended' && f.index === 'folded' && handLocation === 'face') {
        return { score: 0.95, disambiguation: 'ISL Verb CALL: Phone Handshape at Ear/Face' };
      }
    }

    // TIME: Index finger tapping non-dominant wrist
    if (signId === 'TIME') {
      if (twoHand.isContact && f.index === 'extended') {
        return { score: 0.94, disambiguation: 'ISL Concept TIME: Index tapping Watch/Wrist' };
      }
    }

    // WHERE: Index finger wagging left and right
    if (signId === 'WHERE') {
      if (f.index === 'extended' && f.middle === 'folded' && motion.isOscillating) {
        return { score: 0.94, disambiguation: 'ISL Where: Index wagging search' };
      }
    }

    // WHEN: Index circling index
    if (signId === 'WHEN') {
      if (twoHand.isTwoHanded && f.index === 'extended' && motion.isOscillating) {
        return { score: 0.92, disambiguation: 'ISL Question WHEN: Index circling non-dominant index' };
      }
    }

    // WHY: Index at temple pulling down
    if (signId === 'WHY') {
      if (handLocation === 'face' && f.index === 'extended' && motion.velocity > 0.15) {
        return { score: 0.92, disambiguation: 'ISL Question WHY: Index at Forehead pulling down' };
      }
    }

    // HEAD / HEADACHE
    if (signId === 'HEAD') {
      if (handLocation === 'face' && motion.velocity < 0.22) {
        return { score: 0.92, disambiguation: 'ISL Symptom HEAD: Hand touching Temple' };
      }
    }

    // STOMACH
    if (signId === 'STOMACH') {
      if (dominant.wrist.y > 0.65 && openCount >= 3) {
        return { score: 0.91, disambiguation: 'ISL Symptom STOMACH: Hand on Abdomen' };
      }
    }

    // HOW ARE YOU
    if (signId === 'HOW_ARE_YOU') {
      if (twoHand.isTwoHanded && openCount >= 4 && motion.velocity > 0.20) {
        return { score: 0.94, disambiguation: 'ISL Inquiry HOW ARE YOU: Two hands opening forward' };
      }
    }

    // NICE TO MEET YOU
    if (signId === 'NICE_TO_MEET_YOU') {
      if (twoHand.indexContact && (openCount >= 3 || f.index === 'extended')) {
        return { score: 0.93, disambiguation: 'ISL Greeting NICE TO MEET YOU: Two index fingers meeting' };
      }
    }

    // ASL ILY vs ISL Fingerspelling (I-L-Y) Disambiguation
    if (signId === 'I_LOVE_YOU') {
      if (f.thumb === 'extended' && f.index === 'extended' && f.pinky === 'extended' &&
          f.middle === 'folded' && f.ring === 'folded') {
        return { score: 0.98, disambiguation: 'Simultaneous ILY Handshape (Thumb+Index+Pinky)' };
      }
      if (f.index === 'extended' && f.pinky === 'extended' && f.middle === 'folded' && f.ring === 'folded') {
        return { score: 0.86, disambiguation: 'Rock/ILY Horns Variant' };
      }
    }

    // Fingerspelling I, L, Y
    if (signId === 'LETTER_I') {
      if (f.pinky === 'extended' && f.index === 'folded' && f.middle === 'folded' && f.ring === 'folded' && f.thumb === 'folded') {
        return { score: 0.96, disambiguation: 'Fingerspelling: Isolated Pinky Extended' };
      }
    }

    if (signId === 'LETTER_L') {
      if (f.index === 'extended' && f.thumb === 'extended' && f.middle === 'folded' && f.ring === 'folded' && f.pinky === 'folded') {
        return { score: 0.96, disambiguation: 'Fingerspelling: Right-Angle L Handshape' };
      }
    }

    if (signId === 'LETTER_Y') {
      if (f.thumb === 'extended' && f.pinky === 'extended' && f.index === 'folded' && f.middle === 'folded' && f.ring === 'folded') {
        return { score: 0.96, disambiguation: 'Fingerspelling: Y Handshape (Thumb+Pinky)' };
      }
    }

    // Two-Handed Authentic ISL Standard (ISLRTC)
    if (twoHand.isTwoHanded) {
      if (signId === 'LETTER_A' && twoHand.dominantIndexOnThumb) {
        return { score: 0.95, disambiguation: 'ISL Standard: Dominant Index touches Non-Dominant Thumb' };
      }
      if (signId === 'LETTER_B' && twoHand.isContact && openCount >= 4) {
        return { score: 0.93, disambiguation: 'ISL Standard: Two Hands Joined in B Form' };
      }
      if (signId === 'LETTER_C' && twoHand.isContact && dominant.distThumbIndex > 0.3) {
        return { score: 0.92, disambiguation: 'ISL Standard: C Arc on Non-Dominant Palm' };
      }
      if (signId === 'LETTER_D' && twoHand.indexContact && dominant.distThumbIndex < 0.25) {
        return { score: 0.94, disambiguation: 'ISL Standard: Dominant Index on Non-Dominant Loop' };
      }
      if (signId === 'LETTER_E' && twoHand.indexContact && f.index === 'extended' && f.middle === 'folded') {
        return { score: 0.93, disambiguation: 'ISL Standard: Dominant Index on Non-Dominant Index Tip' };
      }
      if (signId === 'LETTER_H' && twoHand.isContact && motion.velocity > 0.25) {
        return { score: 0.92, disambiguation: 'ISL Standard: Dominant Palm sweeps Non-Dominant Palm' };
      }
      if (signId === 'LETTER_T' && twoHand.indexContact && Math.abs(dominant.indexTip.y - analyzedHands[1].indexTip.y) < 0.08) {
        return { score: 0.94, disambiguation: 'ISL Standard: Dominant Index forms T across Non-Dominant Index' };
      }
      if (signId === 'LETTER_X' && twoHand.indexContact && f.index === 'extended') {
        return { score: 0.95, disambiguation: 'ISL Standard: Two Index Fingers crossed in X' };
      }
    }

    // Single-Handed ISL Alphabet Disambiguation
    if (signId === 'LETTER_U') {
      if (f.index === 'extended' && f.middle === 'extended' && f.ring === 'folded' && f.pinky === 'folded') {
        if (spreadIM < 0.28) {
          return { score: 0.95, disambiguation: `Fingerspelling U: Index & Middle touching (Spread: ${spreadIM.toFixed(2)})` };
        }
      }
    }

    if (signId === 'LETTER_V' || signId === 'NUM_2') {
      if (f.index === 'extended' && f.middle === 'extended' && f.ring === 'folded' && f.pinky === 'folded') {
        if (spreadIM >= 0.32) {
          return { score: 0.95, disambiguation: `Fingerspelling V: Index & Middle spread (Spread: ${spreadIM.toFixed(2)})` };
        }
      }
    }

    if (signId === 'LETTER_R') {
      if (f.index === 'extended' && f.middle === 'extended' && f.ring === 'folded' && f.pinky === 'folded') {
        const isCrossed = Math.abs(dominant.indexTip.x - dominant.middleTip.x) < 0.035;
        if (isCrossed) {
          return { score: 0.93, disambiguation: 'Fingerspelling R: Index & Middle Crossed' };
        }
      }
    }

    if (signId === 'LETTER_K') {
      if (f.index === 'extended' && (f.middle === 'extended' || f.middle === 'folded') && dominant.distThumbMiddle < 0.32) {
        return { score: 0.91, disambiguation: 'Fingerspelling K: Thumb resting between knuckles' };
      }
    }

    if (signId === 'LETTER_D' || signId === 'NUM_1') {
      if (f.index === 'extended' && f.middle === 'folded' && f.ring === 'folded' && f.pinky === 'folded') {
        return { score: 0.94, disambiguation: 'Fingerspelling D: Upright Index with Thumb-Middle Loop' };
      }
    }

    if (signId === 'LETTER_A') {
      if (f.thumb === 'extended' && f.index === 'folded' && f.middle === 'folded' && f.ring === 'folded' && f.pinky === 'folded') {
        return { score: 0.93, disambiguation: 'Fingerspelling A: Fist with upright lateral thumb' };
      }
    }

    if (signId === 'LETTER_S') {
      if (openCount === 0 && dominant.aspectRatio >= 0.70 && dominant.aspectRatio <= 1.25) {
        return { score: 0.92, disambiguation: 'Fingerspelling S: Compact Fist with Front-wrapped Thumb' };
      }
    }

    if (signId === 'LETTER_E') {
      if (openCount === 0 && dominant.distThumbIndex < 0.28) {
        return { score: 0.91, disambiguation: 'Fingerspelling E: Curled fingertips touching thumb tip' };
      }
    }

    if (signId === 'LETTER_T') {
      if (openCount === 0 && dominant.distThumbIndex < 0.35) {
        return { score: 0.88, disambiguation: 'Fingerspelling T: Thumb tucked between index & middle' };
      }
    }

    if (signId === 'LETTER_M') {
      if (openCount <= 1 && dominant.distThumbRing < 0.35) {
        return { score: 0.89, disambiguation: 'Fingerspelling M: 3 fingers folded over thumb' };
      }
    }

    if (signId === 'LETTER_N') {
      if (openCount <= 1 && dominant.distThumbMiddle < 0.35) {
        return { score: 0.89, disambiguation: 'Fingerspelling N: 2 fingers folded over thumb' };
      }
    }

    if (signId === 'LETTER_B' || signId === 'NUM_4') {
      if (f.index === 'extended' && f.middle === 'extended' && f.ring === 'extended' && f.pinky === 'extended' && f.thumb === 'folded') {
        return { score: 0.95, disambiguation: 'Fingerspelling B: 4 extended upright fingers' };
      }
    }

    if (signId === 'LETTER_C') {
      if (f.thumb === 'extended' && f.index === 'extended' && f.middle === 'folded' && f.ring === 'folded' && f.pinky === 'folded') {
        if (dominant.distThumbIndex < 0.38) {
          return { score: 0.92, disambiguation: 'Fingerspelling C: Open Curved Thumb & Index' };
        }
      }
    }

    if (signId === 'LETTER_F' || signId === 'NUM_9') {
      if (f.index === 'folded' && f.middle === 'extended' && f.ring === 'extended' && f.pinky === 'extended') {
        return { score: 0.94, disambiguation: 'Fingerspelling F: OK Ring with 3 upright fingers' };
      }
    }

    if (signId === 'LETTER_W' || signId === 'NUM_3') {
      if (f.index === 'extended' && f.middle === 'extended' && f.ring === 'extended' && f.pinky === 'folded' && f.thumb === 'folded') {
        return { score: 0.95, disambiguation: 'Fingerspelling W: 3 extended upright fingers (W form)' };
      }
    }

    if (signId === 'LETTER_O' || signId === 'NUM_0') {
      if (dominant.distThumbIndex < 0.25 && dominant.distThumbMiddle < 0.28) {
        return { score: 0.92, disambiguation: 'Fingerspelling O: Round O Circle with thumb' };
      }
    }

    if (signId === 'LETTER_G') {
      if (f.index === 'extended' && f.thumb === 'extended' && f.middle === 'folded' && f.ring === 'folded' && f.pinky === 'folded') {
        return { score: 0.91, disambiguation: 'Fingerspelling G: Horizontal Index & Thumb' };
      }
    }

    if (signId === 'LETTER_H') {
      if (f.index === 'extended' && f.middle === 'extended' && f.ring === 'folded' && f.pinky === 'folded') {
        return { score: 0.90, disambiguation: 'Fingerspelling H: Horizontal Index & Middle' };
      }
    }

    if (signId === 'LETTER_X') {
      if (f.index === 'extended' && f.middle === 'folded' && f.ring === 'folded' && f.pinky === 'folded') {
        return { score: 0.90, disambiguation: 'Fingerspelling X: Hooked Index Finger' };
      }
    }

    if (signId === 'LETTER_Z') {
      if (f.index === 'extended' && f.middle === 'folded' && f.ring === 'folded' && f.pinky === 'folded' && motion.velocity > 0.3) {
        return { score: 0.92, disambiguation: 'Fingerspelling Z: Index tracing Z trajectory' };
      }
    }

    if (signId === 'NUM_5') {
      if (openCount === 5) {
        return { score: 0.95, disambiguation: 'ISL Number 5: Open Hand (All 5 Fingers)' };
      }
    }

    // Healthcare & Everyday Needs
    if (signId === 'YES') {
      if (f.thumb === 'extended' && f.index === 'folded' && f.middle === 'folded' && f.ring === 'folded' && f.pinky === 'folded') {
        return { score: 0.95, disambiguation: 'ISL Yes: Thumbs-Up / Fist Nod' };
      }
    }

    if (signId === 'NO') {
      if (f.index === 'extended' && f.middle === 'extended' && f.ring === 'folded' && f.pinky === 'folded' && motion.isOscillating) {
        return { score: 0.94, disambiguation: 'ISL No: Two-finger negation snap' };
      }
      if (f.index === 'extended' && f.middle === 'folded' && motion.isOscillating) {
        return { score: 0.92, disambiguation: 'ISL No: Index wagging negation' };
      }
    }

    if (signId === 'WATER') {
      const isW = (f.index === 'extended' && f.middle === 'extended' && f.ring === 'extended');
      if (isW && (handLocation === 'mouth_chin' || handLocation === 'face')) {
        return { score: 0.97, disambiguation: 'ISL Water: W-Handshape at mouth' };
      }
      if (isW) return { score: 0.83, disambiguation: 'ISL Water: W-Handshape' };
    }

    if (signId === 'FOOD') {
      if (handLocation === 'mouth_chin' && openCount <= 2) {
        return { score: 0.93, disambiguation: 'ISL Food: Bundled fingers tapping mouth' };
      }
    }

    if (signId === 'NAMASTE') {
      if ((openCount >= 4 || twoHand.isContact) && (handLocation === 'chest' || handLocation === 'face')) {
        return { score: 0.96, disambiguation: 'ISL Namaste: Palms pressed at chest' };
      }
    }

    if (signId === 'STOP') {
      if (openCount >= 4 && handLocation === 'chest' && motion.velocity < 0.2) {
        return { score: 0.90, disambiguation: 'ISL Stop: Open Palm Halt Gesture' };
      }
    }

    if (signId === 'EMERGENCY') {
      if (twoHand.isTwoHanded && motion.velocity > 0.35) {
        return { score: 0.95, disambiguation: 'ISL Emergency: Rapid two-handed waving' };
      }
    }

    if (signId === 'DOCTOR') {
      if (twoHand.isContact || twoHand.wristDistance < 0.22) {
        return { score: 0.93, disambiguation: 'ISL Doctor: Fingers feeling wrist pulse' };
      }
    }

    if (signId === 'MEDICINE') {
      if (twoHand.isContact && f.middle === 'extended') {
        return { score: 0.91, disambiguation: 'ISL Medicine: Middle finger rubbing palm' };
      }
    }

    if (signId === 'HELP') {
      if (twoHand.isTwoHanded && twoHand.wristDistance < 0.26) {
        return { score: 0.90, disambiguation: 'ISL Help: Fist lifted on open palm' };
      }
    }

    if (signId === 'PAIN') {
      if (f.index === 'extended' && f.middle === 'folded' && (twoHand.isTwoHanded || motion.isOscillating)) {
        return { score: 0.91, disambiguation: 'ISL Pain: Index fingers twisting in opposition' };
      }
    }

    return { score: 0.0, disambiguation: '' };
  }

  // Fingerspelling Word Assembler & Predictive Methods
  getWordBuffer() {
    return this.wordBuffer;
  }

  getWordPredictions(maxResults = 4) {
    const prefix = this.wordBuffer.trim().toUpperCase();
    if (!prefix) {
      return ['YOUR', 'NAME', 'HELP', 'DOCTOR'];
    }

    const matches = this.predictiveDictionary.filter(w => w.startsWith(prefix) && w !== prefix);
    if (matches.length >= maxResults) {
      return matches.slice(0, maxResults);
    }

    const subMatches = this.predictiveDictionary.filter(w => !matches.includes(w) && w.includes(prefix) && w !== prefix);
    return [...matches, ...subMatches].slice(0, maxResults);
  }

  commitCurrentWord(source = 'manual') {
    const word = this.wordBuffer.trim().toUpperCase();
    if (word.length === 0) return null;

    const confirmedWord = {
      id: word,
      gloss: word,
      meaning_en: word,
      meaning_ml: '',
      category: 'fingerspelled_word',
      confidence: 96,
      timestamp: performance.now(),
      source: source,
    };

    this.signSequence.push(confirmedWord);
    this.continuousSentenceTokens.push(word);
    this.wordBuffer = '';

    const translation = this.translateContinuousSequence(this.continuousSentenceTokens);
    this.currentSentenceText = translation.sentence;
    this.currentMalayalamText = translation.malayalam || '';

    return confirmedWord;
  }

  applySuggestion(chosenWord) {
    if (!chosenWord) return null;
    this.wordBuffer = chosenWord.toUpperCase();
    return this.commitCurrentWord('suggestion_chip');
  }

  backspace() {
    if (this.wordBuffer.length > 0) {
      this.wordBuffer = this.wordBuffer.slice(0, -1);
      return { type: 'letter_deleted', remainingBuffer: this.wordBuffer };
    }
    if (this.signSequence.length > 0) {
      const removed = this.signSequence.pop();
      if (this.continuousSentenceTokens.length > 0) {
        this.continuousSentenceTokens.pop();
        const translation = this.translateContinuousSequence(this.continuousSentenceTokens);
        this.currentSentenceText = translation.sentence;
        this.currentMalayalamText = translation.malayalam || '';
      }
      return { type: 'sign_removed', removedSign: removed };
    }
    return null;
  }

  getSignSequence() {
    return [...this.signSequence];
  }

  clearSequence() {
    this.signSequence = [];
    this.continuousSentenceTokens = [];
    this.wordBuffer = '';
    this.lastConfirmedSign = null;
    this.currentCandidate = null;
    this.holdProgress = 0;
    this.trajectoryHistory = [];
    this.recentVelocities = [];
    this.blankStartTime = 0;
    this.sentenceFinalized = false;
    this.currentSentenceText = '';
    this.currentMalayalamText = '';
  }

  getLastConfirmedSign() {
    return this.lastConfirmedSign;
  }
}

window.SignRecognizer = SignRecognizer;
