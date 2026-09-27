import { describe, expect, it } from 'vitest';
import { acceptState, deadlineFor, remainingSeconds, targetFor } from '../core/match';
import type { MatchState } from '../core/protocol';

const state = (revision = 0): MatchState => ({
  protocolVersion: '2.0', roomId: 'BTL1', matchId: 'match-1', revision, phase: 'playing',
  config: { difficultySeconds: 8, challengeCount: 1, countdownSeconds: 3, scoreGraceMs: 1000, synchronizedGestures: true, captureSnapshots: true },
  players: {
    player1: { connected: true, clientId: 'p1', score: 0, attempted: 0, finished: false, challenge: { challengeId: 'c1', technique: 'Hollow Purple', startedAt: 1000, deadlineAt: 9000, pausedRemainingMs: null } },
    player2: { connected: true, clientId: 'p2', score: 0, attempted: 0, finished: false, challenge: null }
  },
  countdownEndsAt: null, resolution: null, cinematic: null, winner: null, pendingWinner: null, updatedAt: 1000
});

describe('deadline match state', () => {
  it('derives remaining time from an absolute deadline', () => {
    expect(remainingSeconds(12_100, 10_000)).toBe(3);
    expect(remainingSeconds(9_999, 10_000)).toBe(0);
  });
  it('ignores stale state revisions', () => {
    const current = state(5), stale = state(4);
    expect(acceptState(current, stale)).toBe(current);
  });
  it('reads the backend challenge target and deadline', () => {
    expect(targetFor(state(), 'player1')).toBe('Hollow Purple');
    expect(deadlineFor(state(), 'player1')).toBe(9000);
  });
});
