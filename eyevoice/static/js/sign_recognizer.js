// sign_recognizer.js — Rule-based ISL (Indian Sign Language) Sign Classifier
// Evaluates MediaPipe Hand, Pose, and Face landmarks against verified linguistic parameters.
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
    this.minConfidenceThreshold = 0.55;

    // Movement history buffer for temporal gestures
    this.historyBuffer = [];
    this.maxHistoryFrames = 30;
  }

  setVocabulary(vocab) {
    if (Array.isArray(vocab)) {
      this.vocabulary = vocab;
    }
  }

  /**
   * Main entrypoint: process one frame of vision data
   */
  processFrame(frameData) {
    const now = frameData.timestamp || performance.now();
    const hands = frameData.hands || [];
    const handedness = frameData.handedness || [];
    const pose = frameData.pose && frameData.pose.length > 0 ? frameData.pose[0] : null;
    const face = frameData.face && frameData.face.length > 0 ? frameData.face[0] : null;
    const blendshapes = frameData.blendshapes || [];

    if (!hands || hands.length === 0) {
      this.currentCandidate = null;
      this.holdProgress = 0;
      return {
        handsDetected: 0,
        currentSign: null,
        isHolding: false,
        holdProgress: 0,
        confirmedSign: null,
        fingerStates: { left: null, right: null },
        handLocation: 'none',
      };
    }

    // 1. Analyze finger states for all detected hands
    const analyzedHands = [];
    for (let i = 0; i < hands.length; i++) {
      const lm = hands[i];
      const hLabel = (handedness[i] && handedness[i][0]) ? handedness[i][0].categoryName : (i === 0 ? 'Right' : 'Left');
      const fingerState = this._detectFingerStates(lm, hLabel);
      const handCenter = lm[0]; // wrist as base anchor
      analyzedHands.push({
        landmarks: lm,
        label: hLabel,
        fingers: fingerState,
        wrist: handCenter,
        indexTip: lm[8],
        thumbTip: lm[4],
      });
    }

    // 2. Determine hand location relative to body anchors (Face & Pose)
    const handLocation = this._detectHandLocation(analyzedHands[0], pose, face);

    // 3. Check two-hand interaction (distance, contact, cross)
    const twoHandRel = this._analyzeTwoHandRelation(analyzedHands);

    // 4. Non-manual facial markers (eyebrow raise, furrow, mouth opening)
    const nonManual = this._extractNonManualMarkers(face, blendshapes);

    // 5. Match candidate sign against vocabulary
    let bestMatch = null;
    let highestScore = 0;

    for (const sign of this.vocabulary) {
      const score = this._scoreSignMatch(sign, analyzedHands, handLocation, twoHandRel, nonManual);
      if (score > highestScore && score >= this.minConfidenceThreshold) {
        highestScore = score;
        bestMatch = {
          id: sign.id,
          gloss: sign.gloss,
          meaning_en: sign.meaning_en,
          meaning_ml: sign.meaning_ml || '',
          confidence: Math.round(score * 100),
          min_hold_ms: (sign.recognition_spec && sign.recognition_spec.min_hold_ms) || 450,
        };
      }
    }

    // 6. Temporal hold logic & confirmation
    let confirmed = null;
    const isCooldown = now < this.cooldownUntil;

    if (bestMatch && !isCooldown) {
      if (!this.currentCandidate || this.currentCandidate.id !== bestMatch.id) {
        this.currentCandidate = bestMatch;
        this.candidateStartTime = now;
        this.holdProgress = 0;
      } else {
        const elapsed = now - this.candidateStartTime;
        const requiredHold = bestMatch.min_hold_ms || 450;
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
          this.cooldownUntil = now + 900; // 900ms cooldown after confirmation
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
   * Detect finger extension / flexion using joint angles and Euclidean distances
   */
  _detectFingerStates(lm, handLabel) {
    if (!lm || lm.length < 21) {
      return { thumb: 'folded', index: 'folded', middle: 'folded', ring: 'folded', pinky: 'folded' };
    }

    const wrist = lm[0];

    // Distance helper
    const dist = (p1, p2) => Math.hypot(p1.x - p2.x, p1.y - p2.y, (p1.z || 0) - (p2.z || 0));

    // Index (5: MCP, 6: PIP, 7: DIP, 8: TIP)
    const indexExtended = (lm[8].y < lm[6].y) && (dist(lm[8], wrist) > dist(lm[6], wrist) * 1.15);

    // Middle (9: MCP, 10: PIP, 11: DIP, 12: TIP)
    const middleExtended = (lm[12].y < lm[10].y) && (dist(lm[12], wrist) > dist(lm[10], wrist) * 1.15);

    // Ring (13: MCP, 14: PIP, 15: DIP, 16: TIP)
    const ringExtended = (lm[16].y < lm[14].y) && (dist(lm[16], wrist) > dist(lm[14], wrist) * 1.15);

    // Pinky (17: MCP, 18: PIP, 19: DIP, 20: TIP)
    const pinkyExtended = (lm[20].y < lm[18].y) && (dist(lm[20], wrist) > dist(lm[18], wrist) * 1.15);

    // Thumb: Compare tip (4) to IP (3) and pinky MCP (17)
    // Thumb is extended if its tip is spread away from palm center / pinky base
    const thumbSpread = dist(lm[4], lm[17]);
    const thumbBase = dist(lm[2], lm[17]);
    const thumbExtended = (thumbSpread > thumbBase * 1.25) || (Math.abs(lm[4].x - lm[2].x) > 0.08);

    return {
      thumb: thumbExtended ? 'extended' : 'folded',
      index: indexExtended ? 'extended' : 'folded',
      middle: middleExtended ? 'extended' : 'folded',
      ring: ringExtended ? 'extended' : 'folded',
      pinky: pinkyExtended ? 'extended' : 'folded',
    };
  }

  /**
   * Determine hand location in body space using Face and Pose reference anchors
   */
  _detectHandLocation(primaryHand, pose, face) {
    if (!primaryHand) return 'unknown';

    const handY = primaryHand.indexTip.y;
    const handX = primaryHand.indexTip.x;

    if (face) {
      const mouthY = face[13] ? face[13].y : 0.4;
      const noseY = face[1] ? face[1].y : 0.35;
      const chinY = face[152] ? face[152].y : 0.45;
      const cheekX_L = face[234] ? face[234].x : 0.4;
      const cheekX_R = face[454] ? face[454].x : 0.6;

      // Close to mouth / lips (within 0.12 radius)
      if (Math.hypot(handX - (face[13]?.x || 0.5), handY - mouthY) < 0.12) {
        return 'mouth_chin';
      }

      // Close to cheek or side of head
      if (Math.abs(handY - noseY) < 0.15 && (Math.abs(handX - cheekX_L) < 0.12 || Math.abs(handX - cheekX_R) < 0.12)) {
        return 'cheek_temple';
      }

      // Above mouth level near face
      if (handY <= chinY + 0.05 && handY >= noseY - 0.15) {
        return 'face';
      }
    }

    if (pose) {
      const leftShoulder = pose[11];
      const rightShoulder = pose[12];
      if (leftShoulder && rightShoulder) {
        const shoulderMidY = (leftShoulder.y + rightShoulder.y) / 2;
        if (handY >= shoulderMidY - 0.1 && handY <= shoulderMidY + 0.3) {
          return 'chest';
        }
      }
    }

    // Default height-based fallback if pose/face landmarks absent
    if (handY < 0.35) return 'face';
    if (handY < 0.70) return 'chest';
    return 'neutral';
  }

  /**
   * Two-hand relation metrics (wrist-to-wrist distance, contact)
   */
  _analyzeTwoHandRelation(analyzedHands) {
    if (analyzedHands.length < 2) {
      return { isTwoHanded: false, wristDistance: 999, isContact: false };
    }
    const h1 = analyzedHands[0];
    const h2 = analyzedHands[1];
    const dx = h1.wrist.x - h2.wrist.x;
    const dy = h1.wrist.y - h2.wrist.y;
    const dist = Math.hypot(dx, dy);

    return {
      isTwoHanded: true,
      wristDistance: dist,
      isContact: dist < 0.18,
    };
  }

  /**
   * Extract non-manual facial markers from Face Landmarker blendshapes & points
   */
  _extractNonManualMarkers(face, blendshapes) {
    const result = {
      eyebrowRaised: false,
      eyebrowFurrowed: false,
      smile: false,
    };

    if (!face || face.length < 468) return result;

    // Direct geometric eyebrow elevation check
    // Landmark 70 = Left Eyebrow inner, 159 = Left Eye top
    // Landmark 300 = Right Eyebrow inner, 386 = Right Eye top
    const leftBrowElev = (face[159]?.y || 0) - (face[70]?.y || 0);
    const rightBrowElev = (face[386]?.y || 0) - (face[300]?.y || 0);
    if (leftBrowElev > 0.055 || rightBrowElev > 0.055) {
      result.eyebrowRaised = true;
    }

    // Mouth corners elevation for smile (Landmarks 61: Left mouth corner, 291: Right mouth corner, 0: Lip top)
    const mouthWidth = Math.hypot((face[291]?.x || 0) - (face[61]?.x || 0), (face[291]?.y || 0) - (face[61]?.y || 0));
    if (mouthWidth > 0.16) {
      result.smile = true;
    }

    return result;
  }

  /**
   * Score a vocabulary sign against current visual frame features
   */
  _scoreSignMatch(sign, analyzedHands, handLocation, twoHandRel, nonManual) {
    const spec = sign.recognition_spec;
    if (!spec) return 0;

    let score = 0;
    const dominantHand = analyzedHands[0];
    if (!dominantHand) return 0;

    // 1. Hand Count Check
    const requiredHands = spec.hands_required || 1;
    if (requiredHands === 2) {
      if (analyzedHands.length >= 2) {
        score += 0.20;
      } else {
        score -= 0.15; // penalty if sign needs 2 hands but only 1 present
      }
    } else {
      score += 0.20; // 1 hand required and at least 1 present
    }

    // 2. Dominant Hand Finger State Matching (0.50 max)
    const targetFingers = (requiredHands === 2 && spec.finger_states && spec.finger_states.dominant)
      ? spec.finger_states.dominant
      : (spec.finger_states || {});

    const detectedFingers = dominantHand.fingers;
    const fingerKeys = ['thumb', 'index', 'middle', 'ring', 'pinky'];
    let matchingFingers = 0;

    for (const key of fingerKeys) {
      const target = targetFingers[key];
      if (!target || target === 'either') {
        matchingFingers++;
      } else if (target === detectedFingers[key]) {
        matchingFingers++;
      }
    }
    score += (matchingFingers / 5) * 0.50;

    // 3. Location Matching (0.20 max)
    const targetLoc = spec.relative_location;
    if (targetLoc) {
      if (targetLoc === 'chest_or_face') {
        if (handLocation === 'chest' || handLocation === 'face' || handLocation === 'mouth_chin') score += 0.20;
      } else if (targetLoc === 'mouth_chin' || targetLoc === 'mouth') {
        if (handLocation === 'mouth_chin' || handLocation === 'face') score += 0.20;
        else score -= 0.10;
      } else if (targetLoc === 'chest' || targetLoc === 'chest_center' || targetLoc === 'chest_forward') {
        if (handLocation === 'chest' || handLocation === 'neutral') score += 0.20;
      } else if (targetLoc === 'cheek_temple') {
        if (handLocation === 'cheek_temple' || handLocation === 'face') score += 0.20;
      } else if (targetLoc === 'wrist_contact') {
        if (twoHandRel.isContact || twoHandRel.wristDistance < 0.22) score += 0.20;
      } else {
        score += 0.10; // neutral match
      }
    } else {
      score += 0.15;
    }

    // 4. Special Sign Signature Rules (0.10 bonus)
    if (sign.id === 'I_LOVE_YOU') {
      // Thumb extended, Index extended, Pinky extended, Middle folded, Ring folded
      if (detectedFingers.thumb === 'extended' && detectedFingers.index === 'extended' &&
          detectedFingers.pinky === 'extended' && detectedFingers.middle === 'folded' &&
          detectedFingers.ring === 'folded') {
        score += 0.15;
      }
    } else if (sign.id === 'YES') {
      // Thumbs up: Thumb extended, all others folded
      if (detectedFingers.thumb === 'extended' && detectedFingers.index === 'folded' &&
          detectedFingers.middle === 'folded' && detectedFingers.ring === 'folded' &&
          detectedFingers.pinky === 'folded') {
        score += 0.15;
      }
    } else if (sign.id === 'PRO-1' || sign.id === 'PRO-2') {
      // Index only extended
      if (detectedFingers.index === 'extended' && detectedFingers.middle === 'folded' &&
          detectedFingers.ring === 'folded' && detectedFingers.pinky === 'folded') {
        score += 0.12;
      }
    } else if (sign.id === 'NAMASTE') {
      // Open hand at chest/face with smile
      if (matchingFingers >= 4) {
        score += 0.10;
      }
    } else if (sign.id === 'WATER' || sign.id === 'FOOD') {
      // Hand near mouth
      if (handLocation === 'mouth_chin' || handLocation === 'face') {
        score += 0.10;
      }
    }

    return Math.min(1.0, Math.max(0.0, score));
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

// Expose on window
window.SignRecognizer = SignRecognizer;
