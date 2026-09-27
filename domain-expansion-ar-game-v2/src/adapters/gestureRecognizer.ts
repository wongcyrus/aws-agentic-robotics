import type { GestureName } from '../core/catalog';

export type Landmark = { x: number; y: number; z?: number };

const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const INDEX_PIP = 6;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const MIDDLE_PIP = 10;
const MIDDLE_TIP = 12;
const RING_MCP = 13;
const RING_PIP = 14;
const RING_TIP = 16;
const PINKY_MCP = 17;
const PINKY_PIP = 18;
const PINKY_TIP = 20;

const distance = (a: Landmark, b: Landmark) =>
  Math.hypot(a.x - b.x, a.y - b.y);
const near = (a: Landmark, b: Landmark, threshold: number) =>
  distance(a, b) < threshold;

function fingerState(
  hand: Landmark[],
  mcp: number,
  pip: number,
  tip: number
) {
  const mcpToPip = distance(hand[mcp], hand[pip]);
  const mcpToTip = distance(hand[mcp], hand[tip]);
  if (mcpToTip > mcpToPip * 1.5) return 1;
  if (mcpToTip < mcpToPip * 0.8) return -1;
  return 0;
}

function fingers(hand: Landmark[]) {
  return {
    i: fingerState(hand, INDEX_MCP, INDEX_PIP, INDEX_TIP) === 1,
    m: fingerState(hand, MIDDLE_MCP, MIDDLE_PIP, MIDDLE_TIP) === 1,
    r: fingerState(hand, RING_MCP, RING_PIP, RING_TIP) === 1,
    p: fingerState(hand, PINKY_MCP, PINKY_PIP, PINKY_TIP) === 1,
    ic: fingerState(hand, INDEX_MCP, INDEX_PIP, INDEX_TIP) === -1,
    mc: fingerState(hand, MIDDLE_MCP, MIDDLE_PIP, MIDDLE_TIP) === -1,
    rc: fingerState(hand, RING_MCP, RING_PIP, RING_TIP) === -1,
    pc: fingerState(hand, PINKY_MCP, PINKY_PIP, PINKY_TIP) === -1
  };
}

function looseFist(hand: Landmark[]) {
  return [
    [INDEX_TIP, INDEX_PIP],
    [MIDDLE_TIP, MIDDLE_PIP],
    [RING_TIP, RING_PIP],
    [PINKY_TIP, PINKY_PIP]
  ].filter(([tip, pip]) => hand[tip].y > hand[pip].y).length >= 3;
}

function shrineScore(hand: Landmark[]) {
  let score = 0;
  if (hand[MIDDLE_TIP].y < hand[WRIST].y + 0.12) score += 1;
  if (hand[RING_TIP].y < hand[WRIST].y + 0.12) score += 1;
  if (hand[INDEX_TIP].y > hand[INDEX_MCP].y - 0.1) score += 1;
  if (hand[PINKY_TIP].y > hand[PINKY_MCP].y - 0.1) score += 1;
  return score;
}

function timeCellHand(hand: Landmark[]) {
  const thumbUp = hand[THUMB_TIP].y < hand[WRIST].y - 0.05;
  const thumbExtended = distance(hand[THUMB_TIP], hand[WRIST]) > 0.09;
  const thumbAboveIndex = hand[THUMB_TIP].y < hand[INDEX_MCP].y;
  const indexUp = hand[INDEX_TIP].y < hand[INDEX_MCP].y - 0.02;
  const indexExtended = distance(hand[INDEX_TIP], hand[INDEX_MCP]) > 0.1;
  const otherFingersDown =
    hand[MIDDLE_TIP].y > hand[MIDDLE_MCP].y - 0.02 &&
    hand[RING_TIP].y > hand[RING_MCP].y - 0.02 &&
    hand[PINKY_TIP].y > hand[PINKY_MCP].y - 0.02;
  return (
    thumbUp &&
    thumbExtended &&
    thumbAboveIndex &&
    indexUp &&
    indexExtended &&
    otherFingersDown
  );
}

function yujiHand(hand: Landmark[]) {
  return (
    hand[INDEX_TIP].y < hand[INDEX_MCP].y - 0.02 &&
    distance(hand[INDEX_TIP], hand[INDEX_MCP]) > 0.1 &&
    hand[MIDDLE_TIP].y > hand[MIDDLE_MCP].y - 0.05 &&
    hand[RING_TIP].y > hand[RING_MCP].y - 0.05 &&
    hand[PINKY_TIP].y > hand[PINKY_MCP].y - 0.05
  );
}

function allDown(hand: Landmark[]) {
  const state = fingers(hand);
  return !state.i && !state.m && !state.r && !state.p;
}

export function detectGesture(hands: Landmark[][]): GestureName | null {
  if (!hands.length) return null;

  const techniqueResults = hands.map((hand) => {
    const state = fingers(hand);
    if (state.i && state.mc) return 'Lapse Blue';
    if (state.i && state.m && state.r) return 'Reversal Red';
    return null;
  });
  const hasBlue = techniqueResults.includes('Lapse Blue');
  const hasRed = techniqueResults.includes('Reversal Red');
  if (hands.length >= 2 && hasBlue && hasRed) return 'Hollow Purple';

  if (hands.length === 1) {
    const hand = hands[0];
    const state = fingers(hand);
    if (hasBlue) return 'Lapse Blue';
    if (hasRed) return 'Reversal Red';
    const middleNearIndex =
      near(hand[MIDDLE_TIP], hand[INDEX_TIP], 0.1) ||
      near(hand[MIDDLE_TIP], hand[INDEX_PIP], 0.1);
    if (state.i && !state.r && !state.p && middleNearIndex) {
      return 'Unlimited Void';
    }
  }

  if (hands.length < 2) return null;
  const [first, second] = hands;
  const horizontalDistance = Math.abs(
    first[WRIST].x - second[WRIST].x
  );
  const verticalDistance = Math.abs(first[WRIST].y - second[WRIST].y);

  if (timeCellHand(first) && timeCellHand(second)) {
    return 'Time Cell Moon Palace';
  }

  if (horizontalDistance > 0.35) {
    for (const [fistHand, openHand] of [
      [first, second],
      [second, first]
    ]) {
      const fist = fingers(fistHand);
      const open = fingers(openHand);
      const isFist =
        (fist.ic && fist.mc && fist.rc && fist.pc) || looseFist(fistHand);
      const openCount = [open.i, open.m, open.r, open.p].filter(Boolean).length;
      if (isFist && openCount >= 3) return 'Authentic Mutual Love';
    }
  }

  if (horizontalDistance <= 0.5 && verticalDistance < 0.2) {
    if (
      yujiHand(first) &&
      yujiHand(second) &&
      distance(first[INDEX_TIP], second[INDEX_TIP]) < 0.3
    ) {
      return 'Yuji Itadori';
    }
    if (allDown(first) && allDown(second)) {
      return 'Chimera Shadow Garden';
    }
    const firstShrine = shrineScore(first);
    const secondShrine = shrineScore(second);
    if (
      (firstShrine >= 3 && secondShrine >= 1) ||
      (secondShrine >= 3 && firstShrine >= 1)
    ) {
      return 'Malevolent Shrine';
    }
    if (
      near(first[PINKY_TIP], second[PINKY_TIP], 0.08) &&
      near(first[THUMB_TIP], second[THUMB_TIP], 0.12)
    ) {
      return 'Self-Embodiment of Perfection';
    }
  }

  if (
    verticalDistance > 0.15 &&
    distance(first[WRIST], second[WRIST]) > 0.2
  ) {
    for (const [upper, lower] of [
      [first, second],
      [second, first]
    ]) {
      if (upper[WRIST].y >= lower[WRIST].y) continue;
      const upperState = fingers(upper);
      const lowerState = fingers(lower);
      const circle = near(upper[THUMB_TIP], upper[INDEX_TIP], 0.22);
      const upperFingers = [
        upperState.m,
        upperState.r,
        upperState.p
      ].filter(Boolean).length >= 1;
      const lowerOpen = [
        lowerState.i,
        lowerState.m,
        lowerState.r,
        lowerState.p
      ].filter(Boolean).length >= 3;
      if (circle && upperFingers && lowerOpen) return 'Idle Death Gamble';
    }
  }

  return null;
}

export class StableGestureRecognizer {
  private readonly history: (GestureName | null)[] = [];

  update(hands: Landmark[][]) {
    this.history.push(detectGesture(hands));
    if (this.history.length > 10) this.history.shift();
    const counts = new Map<GestureName, number>();
    this.history.forEach((name) => {
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    });
    let top: GestureName | null = null;
    let count = 0;
    counts.forEach((candidateCount, candidate) => {
      if (candidateCount > count) {
        top = candidate;
        count = candidateCount;
      }
    });
    return count >= 6 ? top : null;
  }
}
