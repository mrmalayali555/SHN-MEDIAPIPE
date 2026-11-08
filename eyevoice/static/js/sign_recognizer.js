// sign_recognizer.js — Fast, Invariant ISL Sign Recognition Engine
// Uses 3D Euclidean joint geometry invariant to hand orientation and camera distance.
// Exposes window.SignRecognizer.

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
      return {
        handsDetected: 0,
        currentSign: null,
        isHolding: false,
        holdProgress: 0,
        confirmedSign: null,
        fingerStates: { dominant: null, secondary: null },
        handLocation: 'none',
      };
    }

    // 1. Analyze 3D finger states for each hand
    const analyzedHands = [];
    for (let i = 0; i < hands.length; i++) {
      const lm = hands[i];
      const hLabel = (handedness[i] && handedness[i][0]) ? handedness[i][0].categoryName : (i === 0 ? 'Right' : 'Left');
      const fingers = this._detectFingerStates3D(lm);
      analyzedHands.push({
        landmarks: lm,
        label: hLabel,
        fingers: fingers,
        wrist: lm[0],
        indexTip: lm[8],
        thumbTip: lm[4],
      });
    }

    // 2. Body anchor location
    const handLocation = this._detectHandLocation(analyzedHands[0], pose, face);

    // 3. Two-hand relation
    const twoHand = this._analyzeTwoHand(analyzedHands);

    // 4. Candidate matching
    let bestMatch = null;
    let highestScore = 0;

    for (const sign of this.vocabulary) {
      const score = this._scoreSignMatch(sign, analyzedHands, handLocation, twoHand);
      if (score > highestScore && score >= this.minConfidenceThreshold) {
        highestScore = score;
        bestMatch = {
          id: sign.id,
          gloss: sign.gloss,
          meaning_en: sign.meaning_en,
          meaning_ml: sign.meaning_ml || '',
          confidence: Math.round(score * 100),
          min_hold_ms: (sign.recognition_spec && sign.recognition_spec.min_hold_ms) || 350,
        };
      }
    }

    // 5. Temporal stability hold
    let confirmed = null;
    const isCooldown = now < this.cooldownUntil;

    if (bestMatch && !isCooldown) {
      if (!this.currentCandidate || this.currentCandidate.id !== bestMatch.id) {
        this.currentCandidate = bestMatch;
        this.candidateStartTime = now;
        this.holdProgress = 0;
      } else {
        const elapsed = now - this.candidateStartTime;
        const requiredHold = bestMatch.min_hold_ms || 350;
        this.holdProgress = Math.min(1.0, elapsed / requiredHold);

        if (this.holdProgress >= 1.0) {
          confirmed = {
            id: bestMatch.id,
            gloss: bestMatch.gloss,
            meaning_en: bestMatch.meaning_en,
            meaning_ml: bestMatch.meaning_ml,
            confidence: bestMatch.confidence,
            timestamp: now,
          };
          this.signSequence.push(confirmed);
          this.lastConfirmedSign = confirmed;
          this.currentCandidate = null;
          this.holdProgress = 0;
          this.cooldownUntil = now + 800; // 800ms cooldown after confirmation
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
      fingerStates: {
        dominant: analyzedHands[0] ? analyzedHands[0].fingers : null,
        secondary: analyzedHands[1] ? analyzedHands[1].fingers : null,
      },
      handLocation: handLocation,
    };
  }

  /**
   * Orientation-independent 3D Euclidean distance finger state classifier
   */
  _detectFingerStates3D(lm) {
    if (!lm || lm.length < 21) {
      return { thumb: 'folded', index: 'folded', middle: 'folded', ring: 'folded', pinky: 'folded' };
    }

    const dist3D = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));

    // Wrist
    const wrist = lm[0];

    // Helper for non-thumb fingers (MCP, PIP, TIP)
    const isFingerExtended = (mcpIdx, pipIdx, tipIdx) => {
      const mcp = lm[mcpIdx];
      const pip = lm[pipIdx];
      const tip = lm[tipIdx];
      const dTipMcp = dist3D(tip, mcp);
      const dPipMcp = dist3D(pip, mcp);
      const dTipWrist = dist3D(tip, wrist);
      const dPipWrist = dist3D(pip, wrist);

      // In any orientation, when extended, fingertip is significantly further from knuckle than PIP joint
      return (dTipMcp > dPipMcp * 1.30) || (dTipWrist > dPipWrist * 1.15);
    };

    const indexExt  = isFingerExtended(5, 6, 8);
    const middleExt = isFingerExtended(9, 10, 12);
    const ringExt   = isFingerExtended(13, 14, 16);
    const pinkyExt  = isFingerExtended(17, 18, 20);

    // Thumb: Compare tip (4) to IP (3) and Index MCP (5)
    const thumbTip = lm[4];
    const thumbIP = lm[3];
    const thumbMCP = lm[2];
    const indexMCP = lm[5];
    const pinkyMCP = lm[17];

    const dThumbIndex = dist3D(thumbTip, indexMCP);
    const dThumbPinky = dist3D(thumbTip, pinkyMCP);
    const dIPIndex = dist3D(thumbIP, indexMCP);

    const thumbExt = (dThumbIndex > dIPIndex * 1.2) || (dThumbPinky > dist3D(thumbMCP, pinkyMCP) * 1.25);

    return {
      thumb:  thumbExt  ? 'extended' : 'folded',
      index:  indexExt  ? 'extended' : 'folded',
      middle: middleExt ? 'extended' : 'folded',
      ring:   ringExt   ? 'extended' : 'folded',
      pinky:  pinkyExt  ? 'extended' : 'folded',
    };
  }

  _detectHandLocation(primaryHand, pose, face) {
    if (!primaryHand) return 'unknown';

    const handY = primaryHand.indexTip.y;
    const handX = primaryHand.indexTip.x;

    if (face && face.length > 152) {
      const mouthY = face[13] ? face[13].y : 0.4;
      const mouthX = face[13] ? face[13].x : 0.5;

      // Close to mouth
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

    // Height based fallback
    if (handY < 0.38) return 'face';
    if (handY < 0.72) return 'chest';
    return 'neutral';
  }

  _analyzeTwoHand(analyzedHands) {
    if (analyzedHands.length < 2) {
      return { isTwoHanded: false, wristDistance: 999, isContact: false };
    }
    const h1 = analyzedHands[0];
    const h2 = analyzedHands[1];
    const dist = Math.hypot(h1.wrist.x - h2.wrist.x, h1.wrist.y - h2.wrist.y);
    return {
      isTwoHanded: true,
      wristDistance: dist,
      isContact: dist < 0.22,
    };
  }

  _scoreSignMatch(sign, analyzedHands, handLocation, twoHand) {
    const spec = sign.recognition_spec;
    if (!spec) return 0;

    const dominant = analyzedHands[0];
    if (!dominant) return 0;

    const f = dominant.fingers;
    const signId = sign.id;

    // Direct High-Accuracy Gesture Templates
    if (signId === 'I_LOVE_YOU') {
      // Thumb extended, Index extended, Pinky extended, Middle & Ring folded
      if (f.thumb === 'extended' && f.index === 'extended' && f.pinky === 'extended' &&
          f.middle === 'folded' && f.ring === 'folded') {
        return 0.95;
      }
      if (f.index === 'extended' && f.pinky === 'extended' && f.middle === 'folded' && f.ring === 'folded') {
        return 0.85;
      }
    }

    if (signId === 'YES') {
      // Thumbs-up: Thumb extended, all other 4 folded
      if (f.thumb === 'extended' && f.index === 'folded' && f.middle === 'folded' &&
          f.ring === 'folded' && f.pinky === 'folded') {
        return 0.95;
      }
    }

    if (signId === 'NO') {
      // Index & Middle extended (V/Peace shape or scissor snap)
      if (f.index === 'extended' && f.middle === 'extended' && f.ring === 'folded' && f.pinky === 'folded') {
        return 0.92;
      }
    }

    if (signId === 'WATER') {
      // 3 fingers (W-hand: index, middle, ring extended) near mouth/chin
      const isWHand = (f.index === 'extended' && f.middle === 'extended' && f.ring === 'extended');
      if (isWHand && (handLocation === 'mouth_chin' || handLocation === 'face')) {
        return 0.95;
      }
      if (isWHand) {
        return 0.82;
      }
    }

    if (signId === 'FOOD') {
      // Fingertips near mouth
      if (handLocation === 'mouth_chin' && (f.index === 'folded' || f.middle === 'folded')) {
        return 0.88;
      }
    }

    if (signId === 'NAMASTE') {
      // Open hand (all 5 fingers extended) at chest or face
      const openCount = [f.thumb, f.index, f.middle, f.ring, f.pinky].filter(x => x === 'extended').length;
      if (openCount >= 4 && (handLocation === 'chest' || handLocation === 'face')) {
        return 0.92;
      }
      if (openCount >= 4) {
        return 0.80;
      }
    }

    if (signId === 'STOP') {
      // Open flat hand facing forward
      const openCount = [f.index, f.middle, f.ring, f.pinky].filter(x => x === 'extended').length;
      if (openCount >= 4 && handLocation === 'chest') {
        return 0.88;
      }
    }

    if (signId === 'PRO-1') {
      // Single index finger pointing
      if (f.index === 'extended' && f.middle === 'folded' && f.ring === 'folded' && f.pinky === 'folded') {
        if (handLocation === 'chest') return 0.92;
        return 0.80;
      }
    }

    if (signId === 'DOCTOR') {
      // Two hands close together (tapping wrist)
      if (twoHand.isContact || twoHand.wristDistance < 0.20) {
        return 0.88;
      }
    }

    if (signId === 'HELP') {
      // Two hands close together in front of chest
      if (twoHand.isTwoHanded && twoHand.wristDistance < 0.25) {
        return 0.85;
      }
    }

    if (signId === 'PLEASE') {
      // Open hand on chest
      const openCount = [f.index, f.middle, f.ring, f.pinky].filter(x => x === 'extended').length;
      if (openCount >= 4 && handLocation === 'chest') {
        return 0.80;
      }
    }

    return 0.0;
  }

  getSignSequence() {
    return [...this.signSequence];
  }

  clearSequence() {
    this.signSequence = [];
    this.lastConfirmedSign = null;
    this.currentCandidate = null;
    this.holdProgress = 0;
  }

  getLastConfirmedSign() {
    return this.lastConfirmedSign;
  }
}

window.SignRecognizer = SignRecognizer;
