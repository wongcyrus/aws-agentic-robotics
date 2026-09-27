import { describe, expect, it } from 'vitest';
import { ClientMessageSchema, createCommand, parseServerEnvelope } from '../core/protocol';

describe('protocol validation', () => {
  it('builds a versioned command envelope', () => {
    const message = createCommand('challenge.succeeded', 'BTL1', 7, 'match-1', {
      challengeId: 'challenge-1', technique: 'Unlimited Void', videoSrc: '/video.mp4'
    });
    expect(ClientMessageSchema.parse(message)).toMatchObject({
      action: 'command',
      envelope: { protocolVersion: '2.0', messageType: 'challenge.succeeded', roomId: 'BTL1', matchId: 'match-1', revision: 7 }
    });
  });
  it('accepts a valid room snapshot and rejects legacy messages', () => {
    const state = {
      protocolVersion: '2.0', roomId: 'BTL1', matchId: null, revision: 1, phase: 'idle',
      config: { difficultySeconds: 8, challengeCount: 11, countdownSeconds: 3, scoreGraceMs: 1000, synchronizedGestures: false, captureSnapshots: true },
      players: {
        player1: { connected: false, clientId: null, score: 0, attempted: 0, finished: false, challenge: null },
        player2: { connected: false, clientId: null, score: 0, attempted: 0, finished: false, challenge: null }
      },
      countdownEndsAt: null, resolution: null, cinematic: null, winner: null, pendingWinner: null, updatedAt: 1000
    };
    expect(parseServerEnvelope({
      protocolVersion: '2.0', messageId: 'event-1', messageType: 'room.snapshot', roomId: 'BTL1',
      matchId: null, revision: 1, sentAt: 1000, payload: { state }
    })?.messageType).toBe('room.snapshot');
    expect(parseServerEnvelope({ type: 'state_update', data: state })).toBeNull();
  });
  it('defaults snapshot capture for protocol 2.0 states created before the option existed', () => {
    const state = {
      protocolVersion: '2.0', roomId: 'BTL1', matchId: null, revision: 1, phase: 'idle',
      config: { difficultySeconds: 8, challengeCount: 11, countdownSeconds: 3, scoreGraceMs: 1000, synchronizedGestures: false },
      players: {
        player1: { connected: false, clientId: null, score: 0, attempted: 0, finished: false, challenge: null },
        player2: { connected: false, clientId: null, score: 0, attempted: 0, finished: false, challenge: null }
      },
      countdownEndsAt: null, resolution: null, cinematic: null, winner: null, pendingWinner: null, updatedAt: 1000
    };
    const parsed = parseServerEnvelope({
      protocolVersion: '2.0', messageId: 'event-1', messageType: 'room.snapshot', roomId: 'BTL1',
      matchId: null, revision: 1, sentAt: 1000, payload: { state }
    });
    expect(parsed?.messageType === 'room.snapshot' && parsed.payload.state.config.captureSnapshots).toBe(true);
  });
});
