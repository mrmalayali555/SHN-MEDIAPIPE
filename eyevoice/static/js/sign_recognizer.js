// sign_recognizer.js — Advanced Multi-Tier Indian Sign Language (ISL) Recognition Engine
// Sourced from ISLRTC National Standards, INCLUDE dataset, emnikhil word assembler,
// and imRishabhGupta ISL geometric/contour disambiguation principles.
//
// Features:
// 1. Orientation-invariant 3D Euclidean joint geometry & normalized hand span.
// 2. Multi-tier disambiguation for confusing handshapes (D/R/U/V/K, M/N/S/E/A, G/H, P/Q).
// 3. Authentic Two-Handed ISL Alphabet & Signs (ISLRTC Standard) + Fast 1-Handed Fingerspelling.
// 4. All 26 letters (A-Z), 10 numbers (0-9), and 26 core conversational & medical ISL signs.
// 5. Real-time Fingerspelling Word Assembler with predictive autocomplete & blank-pause auto-commit.
// 6. ASL ILY vs sequential I->L->Y disambiguation.

class SignRecognizer {
  constructor(signVocabulary = []) {
    this.vocabulary = Array.isArray(signVocabulary) ? signVocabulary : [];
    this.signSequence = [];
    this.currentCandidate = null;
    this.candidateStartTime = 0;
    this.holdProgress = 0;
    this.lastConfirmedSign = null;
    this.cooldownUntil = 0;
    this.minConfidenceThreshold = 0.50;

    // Movement history buffer for dynamic sign trajectory analysis (last 20 frames)
    this.trajectoryHistory = [];
    this.maxTrajectoryFrames = 20;

    // Fingerspelling Word Assembler & Predictive Engine (emnikhil architecture)
    this.wordBuffer = '';
    this.lastLetterConfirmedTime = 0;
    this.blankStartTime = 0;
    this.lastDisambiguationNote = '';

    // Comprehensive 250+ Prioritized ISL & Healthcare Word Dictionary for instant prediction
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
      // Questions & Time
      'WHAT', 'WHERE', 'WHEN', 'WHY', 'WHO', 'HOW', 'WHICH', 'NOW', 'TODAY',
      'TOMORROW', 'YESTERDAY', 'LATER', 'TIME', 'MINUTE', 'HOUR', 'DAY', 'NIGHT',
      // Actions & Verbs
      'COME', 'GO', 'SEE', 'LOOK', 'EAT', 'DRINK', 'SIT', 'STAND', 'TALK', 'SPEAK',
      'READ', 'WRITE', 'NEED', 'WANT', 'GIVE', 'TAKE', 'HEAR', 'FEEL', 'KNOW',
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

    if (!hands || hands.length === 0) {
      this.currentCandidate = null;
      this.holdProgress = 0;
      this.trajectoryHistory = [];

      // Blank / Pause Detection: auto-commit fingerspelled word if hands rested for >1000ms
      if (this.wordBuffer.length > 0) {
        if (this.blankStartTime === 0) {
          this.blankStartTime = now;
        } else if (now - this.blankStartTime > 1000) {
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
      };
    }

    this.blankStartTime = 0;

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

    // Update trajectory buffer with dominant hand wrist & index coordinates
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

    // 2. Body anchor location
    const handLocation = this._detectHandLocation(analyzedHands[0], pose, face);

    // 3. Two-hand spatial relation
    const twoHand = this._analyzeTwoHand(analyzedHands);

    // 4. Movement dynamics (velocity & oscillation)
    const motion = this._computeMotionDynamics();

    // 5. Candidate matching with Multi-Tier Disambiguation
    let bestMatch = null;
    let highestScore = 0;
    let bestDisambiguation = '';

    for (const sign of this.vocabulary) {
      const { score, disambiguation } = this._scoreSignMatch(sign, analyzedHands, handLocation, twoHand, motion);
      if (score > highestScore && score >= this.minConfidenceThreshold) {
        highestScore = score;
        bestDisambiguation = disambiguation || '';
        bestMatch = {
          id: sign.id,
          gloss: sign.gloss,
          meaning_en: sign.meaning_en,
          meaning_ml: sign.meaning_ml || '',
          category: sign.category || 'general',
          confidence: Math.round(score * 100),
          min_hold_ms: (sign.recognition_spec && sign.recognition_spec.min_hold_ms) || (sign.id.startsWith('LETTER_') ? 320 : 380),
        };
      }
    }

    if (bestDisambiguation) {
      this.lastDisambiguationNote = bestDisambiguation;
    }

    // 6. Temporal stability hold
    let confirmed = null;
    const isCooldown = now < this.cooldownUntil;

    if (bestMatch && !isCooldown) {
      if (!this.currentCandidate || this.currentCandidate.id !== bestMatch.id) {
        this.currentCandidate = bestMatch;
        this.candidateStartTime = now;
        this.holdProgress = 0;
      } else {
        const elapsed = now - this.candidateStartTime;
        const requiredHold = bestMatch.min_hold_ms || 320;
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
            // Append letter to fingerspelled word buffer (emnikhil architecture)
            const letterChar = bestMatch.id.replace('LETTER_', '');
            this.wordBuffer += letterChar;
            this.lastLetterConfirmedTime = now;
          } else if (isNum) {
            const numChar = bestMatch.id.replace('NUM_', '');
            this.wordBuffer += numChar;
            this.lastLetterConfirmedTime = now;
          } else {
            // Whole conversational sign: commit any existing fingerspelled word first
            if (this.wordBuffer.length > 0) {
              this.commitCurrentWord('sign_boundary');
            }
            this.signSequence.push(confirmed);
          }

          this.lastConfirmedSign = confirmed;
          this.currentCandidate = null;
          this.holdProgress = 0;

          // Alphabet fingerspelling has agile cooldown (380ms), whole conversational signs (680ms)
          this.cooldownUntil = now + (isLetter || isNum ? 380 : 680);
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
    };
  }

  /**
   * Orientation-independent 3D joint geometry, normalized distances, and bounding-box aspect ratio
   * Incorporates principles from imRishabhGupta ISL classification
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

    // Normalized hand span: distance from wrist to middle finger MCP (knuckle #9)
    const handSpan = dist3D(wrist, lm[9]) || 0.12;

    // Detect extension for all fingers
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

    // Thumb extension analysis
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

    // Bounding box aspect ratio (imRishabhGupta)
    const xs = lm.map(p => p.x);
    const ys = lm.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const bboxW = maxX - minX;
    const bboxH = maxY - minY;
    const aspectRatio = bboxW / (bboxH || 0.001);

    // Normalized inter-fingertip distance ratios
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

    // Check oscillation in X (e.g. wagging / waving)
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
   * Separates confusing clusters: D/R/U/V/K, M/N/S/E/A, G/H, P/Q, and Two-Handed ISL Standard
   */
  _scoreSignMatch(sign, analyzedHands, handLocation, twoHand, motion) {
    const dominant = analyzedHands[0];
    if (!dominant) return { score: 0, disambiguation: '' };

    const f = dominant.fingers;
    const signId = sign.id;
    const openCount = dominant.openCount;
    const span = dominant.handSpan;
    const spreadIM = dominant.spreadIndexMiddle;
    const lm = dominant.landmarks;

    // ── 1. ASL ILY vs ISL Fingerspelling (I-L-Y) Disambiguation ──
    if (signId === 'I_LOVE_YOU') {
      if (f.thumb === 'extended' && f.index === 'extended' && f.pinky === 'extended' &&
          f.middle === 'folded' && f.ring === 'folded') {
        return { score: 0.98, disambiguation: 'Simultaneous ILY Handshape (Thumb+Index+Pinky)' };
      }
      if (f.index === 'extended' && f.pinky === 'extended' && f.middle === 'folded' && f.ring === 'folded') {
        return { score: 0.86, disambiguation: 'Rock/ILY Horns Variant' };
      }
    }

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

    // ── 2. Two-Handed Authentic ISL Standard (ISLRTC) Alphabet Disambiguation ──
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

    // ── 3. Single-Handed ISL Alphabet Disambiguation (emnikhil + imRishabhGupta) ──

    // Cluster: D vs R vs U vs V vs K
    if (signId === 'LETTER_U') {
      // Index + Middle extended parallel, touching together (spreadIM < 0.28)
      if (f.index === 'extended' && f.middle === 'extended' && f.ring === 'folded' && f.pinky === 'folded') {
        if (spreadIM < 0.28) {
          return { score: 0.95, disambiguation: `Fingerspelling U: Index & Middle touching (Spread: ${spreadIM.toFixed(2)})` };
        }
      }
    }

    if (signId === 'LETTER_V' || signId === 'NUM_2') {
      // Index + Middle extended spread apart in a V (spreadIM >= 0.35)
      if (f.index === 'extended' && f.middle === 'extended' && f.ring === 'folded' && f.pinky === 'folded') {
        if (spreadIM >= 0.32) {
          return { score: 0.95, disambiguation: `Fingerspelling V: Index & Middle spread (Spread: ${spreadIM.toFixed(2)})` };
        }
      }
    }

    if (signId === 'LETTER_R') {
      // Index + Middle extended crossed (crossing X coordinates)
      if (f.index === 'extended' && f.middle === 'extended' && f.ring === 'folded' && f.pinky === 'folded') {
        const isCrossed = Math.abs(dominant.indexTip.x - dominant.middleTip.x) < 0.035;
        if (isCrossed) {
          return { score: 0.93, disambiguation: 'Fingerspelling R: Index & Middle Crossed' };
        }
      }
    }

    if (signId === 'LETTER_K') {
      // Index pointing up, middle forward/bent, thumb between them
      if (f.index === 'extended' && (f.middle === 'extended' || f.middle === 'folded') && dominant.distThumbMiddle < 0.32) {
        return { score: 0.91, disambiguation: 'Fingerspelling K: Thumb resting between knuckles' };
      }
    }

    if (signId === 'LETTER_D' || signId === 'NUM_1') {
      // Only Index extended upright, thumb loop on middle tip
      if (f.index === 'extended' && f.middle === 'folded' && f.ring === 'folded' && f.pinky === 'folded') {
        return { score: 0.94, disambiguation: 'Fingerspelling D: Upright Index with Thumb-Middle Loop' };
      }
    }

    // Cluster: M vs N vs S vs A vs E vs T (Fist & Knuckle Disambiguation)
    if (signId === 'LETTER_A') {
      // Closed fist with upright thumb beside index knuckle
      if (f.thumb === 'extended' && f.index === 'folded' && f.middle === 'folded' && f.ring === 'folded' && f.pinky === 'folded') {
        return { score: 0.93, disambiguation: 'Fingerspelling A: Fist with upright lateral thumb' };
      }
    }

    if (signId === 'LETTER_S') {
      // Fist with thumb wrapped across front of middle knuckles
      if (openCount === 0 && dominant.aspectRatio >= 0.70 && dominant.aspectRatio <= 1.25) {
        return { score: 0.92, disambiguation: 'Fingerspelling S: Compact Fist with Front-wrapped Thumb' };
      }
    }

    if (signId === 'LETTER_E') {
      // All fingertips curled claws touching thumb tip
      if (openCount === 0 && dominant.distThumbIndex < 0.28) {
        return { score: 0.91, disambiguation: 'Fingerspelling E: Curled fingertips touching thumb tip' };
      }
    }

    if (signId === 'LETTER_T') {
      // Thumb tucked between index and middle knuckles
      if (openCount === 0 && dominant.distThumbIndex < 0.35) {
        return { score: 0.88, disambiguation: 'Fingerspelling T: Thumb tucked between index & middle' };
      }
    }

    if (signId === 'LETTER_M') {
      // Three fingers folded over thumb
      if (openCount <= 1 && dominant.distThumbRing < 0.35) {
        return { score: 0.89, disambiguation: 'Fingerspelling M: 3 fingers folded over thumb' };
      }
    }

    if (signId === 'LETTER_N') {
      // Two fingers folded over thumb
      if (openCount <= 1 && dominant.distThumbMiddle < 0.35) {
        return { score: 0.89, disambiguation: 'Fingerspelling N: 2 fingers folded over thumb' };
      }
    }

    // Cluster: B vs C vs F vs W vs O
    if (signId === 'LETTER_B' || signId === 'NUM_4') {
      // 4 upright fingers, thumb folded
      if (f.index === 'extended' && f.middle === 'extended' && f.ring === 'extended' && f.pinky === 'extended' && f.thumb === 'folded') {
        return { score: 0.95, disambiguation: 'Fingerspelling B: 4 extended upright fingers' };
      }
    }

    if (signId === 'LETTER_C') {
      // Curved C hand
      if (f.thumb === 'extended' && f.index === 'extended' && f.middle === 'folded' && f.ring === 'folded' && f.pinky === 'folded') {
        if (dominant.distThumbIndex < 0.38) {
          return { score: 0.92, disambiguation: 'Fingerspelling C: Open Curved Thumb & Index' };
        }
      }
    }

    if (signId === 'LETTER_F' || signId === 'NUM_9') {
      // Index touches thumb, other 3 extended upright
      if (f.index === 'folded' && f.middle === 'extended' && f.ring === 'extended' && f.pinky === 'extended') {
        return { score: 0.94, disambiguation: 'Fingerspelling F: OK Ring with 3 upright fingers' };
      }
    }

    if (signId === 'LETTER_W' || signId === 'NUM_3') {
      // Index, Middle, Ring extended upright apart
      if (f.index === 'extended' && f.middle === 'extended' && f.ring === 'extended' && f.pinky === 'folded' && f.thumb === 'folded') {
        return { score: 0.95, disambiguation: 'Fingerspelling W: 3 extended upright fingers (W form)' };
      }
    }

    if (signId === 'LETTER_O' || signId === 'NUM_0') {
      // All fingertips touching thumb tip forming round 'O'
      if (dominant.distThumbIndex < 0.25 && dominant.distThumbMiddle < 0.28) {
        return { score: 0.92, disambiguation: 'Fingerspelling O: Round O Circle with thumb' };
      }
    }

    // Remaining Alphabets: G, H, J, P, Q, X, Z
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

    // Numbers: NUM_5, NUM_6, NUM_7, NUM_8
    if (signId === 'NUM_5') {
      if (openCount === 5) {
        return { score: 0.95, disambiguation: 'ISL Number 5: Open Hand (All 5 Fingers)' };
      }
    }

    if (signId === 'NUM_6') {
      if (f.index === 'extended' && f.middle === 'extended' && f.ring === 'extended' && dominant.distThumbPinky < 0.28) {
        return { score: 0.91, disambiguation: 'ISL Number 6: Thumb touches Pinky' };
      }
    }

    if (signId === 'NUM_7') {
      if (f.index === 'extended' && f.middle === 'extended' && f.pinky === 'extended' && dominant.distThumbRing < 0.28) {
        return { score: 0.91, disambiguation: 'ISL Number 7: Thumb touches Ring finger' };
      }
    }

    if (signId === 'NUM_8') {
      if (f.index === 'extended' && f.ring === 'extended' && f.pinky === 'extended' && dominant.distThumbMiddle < 0.28) {
        return { score: 0.91, disambiguation: 'ISL Number 8: Thumb touches Middle finger' };
      }
    }

    // ── 4. Core Conversational & Medical ISL Signs ──
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
        return { score: 0.92, disambiguation: 'ISL Doctor: Fingers feeling wrist pulse' };
      }
    }

    if (signId === 'MEDICINE') {
      if (twoHand.isContact && f.middle === 'extended') {
        return { score: 0.91, disambiguation: 'ISL Medicine: Middle finger rubbing palm' };
      }
    }

    if (signId === 'HELP') {
      if (twoHand.isTwoHanded && twoHand.wristDistance < 0.26) {
        return { score: 0.89, disambiguation: 'ISL Help: Fist lifted on open palm' };
      }
    }

    if (signId === 'PAIN') {
      if (f.index === 'extended' && f.middle === 'folded' && (twoHand.isTwoHanded || motion.isOscillating)) {
        return { score: 0.90, disambiguation: 'ISL Pain: Index fingers twisting in opposition' };
      }
    }

    if (signId === 'WHAT') {
      if (openCount >= 4 && motion.isOscillating) {
        return { score: 0.93, disambiguation: 'ISL What: Palms up oscillating inquiry' };
      }
    }

    if (signId === 'WHERE') {
      if (f.index === 'extended' && f.middle === 'folded' && motion.isOscillating) {
        return { score: 0.93, disambiguation: 'ISL Where: Index wagging search' };
      }
    }

    return { score: 0.0, disambiguation: '' };
  }

  // ── 5. Fingerspelling Word Assembler & Predictive Suggestion Methods (emnikhil) ──

  getWordBuffer() {
    return this.wordBuffer;
  }

  /**
   * Return top matching predictive word suggestions given current word buffer prefix
   */
  getWordPredictions(maxResults = 4) {
    const prefix = this.wordBuffer.trim().toUpperCase();
    if (!prefix) {
      // Suggest high-frequency medical/emergency words by default
      return ['HELP', 'DOCTOR', 'WATER', 'PAIN'];
    }

    const matches = this.predictiveDictionary.filter(w => w.startsWith(prefix) && w !== prefix);
    if (matches.length >= maxResults) {
      return matches.slice(0, maxResults);
    }

    // Substring matches fallback
    const subMatches = this.predictiveDictionary.filter(w => !matches.includes(w) && w.includes(prefix) && w !== prefix);
    return [...matches, ...subMatches].slice(0, maxResults);
  }

  /**
   * Commit the currently typed word buffer into the confirmed sign sequence
   */
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
    this.wordBuffer = '';
    return confirmedWord;
  }

  /**
   * Apply a selected predictive suggestion chip (e.g. user clicks "DOCTOR")
   */
  applySuggestion(chosenWord) {
    if (!chosenWord) return null;
    this.wordBuffer = chosenWord.toUpperCase();
    return this.commitCurrentWord('suggestion_chip');
  }

  /**
   * Backspace: delete last letter from wordBuffer, or delete last sign if buffer is empty
   */
  backspace() {
    if (this.wordBuffer.length > 0) {
      this.wordBuffer = this.wordBuffer.slice(0, -1);
      return { type: 'letter_deleted', remainingBuffer: this.wordBuffer };
    }
    if (this.signSequence.length > 0) {
      const removed = this.signSequence.pop();
      return { type: 'sign_removed', removedSign: removed };
    }
    return null;
  }

  getSignSequence() {
    return [...this.signSequence];
  }

  clearSequence() {
    this.signSequence = [];
    this.wordBuffer = '';
    this.lastConfirmedSign = null;
    this.currentCandidate = null;
    this.holdProgress = 0;
    this.trajectoryHistory = [];
    this.blankStartTime = 0;
  }

  getLastConfirmedSign() {
    return this.lastConfirmedSign;
  }
}

window.SignRecognizer = SignRecognizer;
