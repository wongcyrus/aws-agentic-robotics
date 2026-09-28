import { z } from 'zod';
import { gestureNames } from './catalog';

export const PROTOCOL_VERSION = '2.0' as const;
export const RoleSchema = z.enum(['player1', 'player2', 'viewer']);
export type Role = z.infer<typeof RoleSchema>;
export const PlayerRoleSchema = z.enum(['player1', 'player2']);
export type PlayerRole = z.infer<typeof PlayerRoleSchema>;
export const MatchPhaseSchema = z.enum(['idle', 'preparing', 'countdown', 'playing', 'resolving', 'cinematic', 'ended']);
export type MatchPhase = z.infer<typeof MatchPhaseSchema>;
export const GestureNameSchema = z.enum(gestureNames);

export const ChallengeSchema = z.object({
  challengeId: z.string(),
  technique: GestureNameSchema,
  startedAt: z.number().int(),
  deadlineAt: z.number().int().nullable(),
  pausedRemainingMs: z.number().int().nullable().optional()
});
export type Challenge = z.infer<typeof ChallengeSchema>;

export const PlayerStateSchema = z.object({
  connected: z.boolean(),
  clientId: z.string().nullable(),
  score: z.number().int().nonnegative(),
  attempted: z.number().int().nonnegative(),
  finished: z.boolean(),
  challenge: ChallengeSchema.nullable()
});
export type PlayerState = z.infer<typeof PlayerStateSchema>;

const CastSchema = z.object({
  role: PlayerRoleSchema,
  technique: GestureNameSchema,
  videoSrc: z.string().nullish()
});
const ResolutionSchema = z.object({
  resolutionId: z.string(),
  acceptUntil: z.number().int(),
  casts: z.array(CastSchema)
});
const CinematicSchema = z.object({
  cinematicId: z.string(),
  casts: z.array(CastSchema),
  startedAt: z.number().int(),
  fallbackEndsAt: z.number().int()
});
export const WinnerSchema = z.enum(['PLAYER 1', 'PLAYER 2', 'DRAW']);

export const MatchStateSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  roomId: z.string().min(1).max(32),
  matchId: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  phase: MatchPhaseSchema,
  config: z.object({
    difficultySeconds: z.number().int().min(1).max(120),
    challengeCount: z.number().int().min(1).max(100),
    countdownSeconds: z.number().int().min(0).max(30),
    scoreGraceMs: z.number().int().min(0).max(5000),
    synchronizedGestures: z.boolean(),
    captureSnapshots: z.boolean().default(true)
  }),
  players: z.object({ player1: PlayerStateSchema, player2: PlayerStateSchema }),
  countdownEndsAt: z.number().int().nullable(),
  resolution: ResolutionSchema.nullable(),
  cinematic: CinematicSchema.nullable(),
  winner: WinnerSchema.nullable(),
  pendingWinner: WinnerSchema.nullable(),
  updatedAt: z.number().int()
});
export type MatchState = z.infer<typeof MatchStateSchema>;

export const WebRtcSignalTypeSchema = z.enum(['playerReady', 'viewerRequested', 'offer', 'answer', 'iceCandidate', 'peerClosed']);
export type WebRtcSignalType = z.infer<typeof WebRtcSignalTypeSchema>;
export const WebRtcPayloadSchema = z.object({
  sdp: z.string().optional(),
  candidate: z.string().nullable().optional(),
  sdpMid: z.string().nullable().optional(),
  sdpMLineIndex: z.number().nullable().optional()
});
export type WebRtcPayload = z.infer<typeof WebRtcPayloadSchema>;

export const CommandTypeSchema = z.enum([
  'match.start', 'match.beginCountdown', 'match.countdownCompleted', 'match.reset',
  'challenge.succeeded', 'challenge.timedOut', 'challenge.expire',
  'resolution.complete', 'cinematic.completed'
]);
export type CommandType = z.infer<typeof CommandTypeSchema>;

export const CommandEnvelopeSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  messageId: z.string().min(1),
  messageType: CommandTypeSchema,
  roomId: z.string().min(1),
  matchId: z.string().optional(),
  revision: z.number().int().nonnegative(),
  sentAt: z.number().int(),
  correlationId: z.string().optional(),
  payload: z.record(z.string(), z.unknown())
});
export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;

export const ClientMessageSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('join'), roomId: z.string(), role: RoleSchema, clientId: z.string() }),
  z.object({ action: z.literal('command'), envelope: CommandEnvelopeSchema }),
  z.object({ action: z.literal('signal'), roomId: z.string(), to: z.string().optional(), signalType: WebRtcSignalTypeSchema, payload: WebRtcPayloadSchema }),
  z.object({ action: z.literal('ping') })
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

const EnvelopeBaseSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  messageId: z.string(),
  roomId: z.string(),
  matchId: z.string().nullable().optional(),
  revision: z.number().int().nonnegative(),
  sentAt: z.number().int(),
  correlationId: z.string().nullable().optional()
});
const RoomSnapshotEnvelopeSchema = EnvelopeBaseSchema.extend({
  messageType: z.literal('room.snapshot'),
  payload: z.object({ state: MatchStateSchema })
});
export const WebRtcMessageTypeSchema = z.enum([
  'webrtc.playerReady', 'webrtc.viewerRequested', 'webrtc.offer',
  'webrtc.answer', 'webrtc.iceCandidate', 'webrtc.peerClosed'
]);
const WebRtcEnvelopeSchema = EnvelopeBaseSchema.extend({
  messageType: WebRtcMessageTypeSchema,
  payload: z.object({ from: z.string(), role: RoleSchema, data: WebRtcPayloadSchema })
});
const AcknowledgementEnvelopeSchema = EnvelopeBaseSchema.extend({
  messageType: z.literal('command.acknowledged'),
  payload: z.object({ duplicate: z.boolean().optional() }).passthrough()
});
const RejectedEnvelopeSchema = EnvelopeBaseSchema.extend({
  messageType: z.literal('command.rejected'),
  payload: z.object({ reason: z.string() })
});
export const ServerEnvelopeSchema = z.union([RoomSnapshotEnvelopeSchema, WebRtcEnvelopeSchema, AcknowledgementEnvelopeSchema, RejectedEnvelopeSchema]);
export type ServerEnvelope = z.infer<typeof ServerEnvelopeSchema>;

export const newMessageId = () => globalThis.crypto?.randomUUID?.() ?? `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
export function createCommand(
  messageType: CommandType,
  roomId: string,
  revision: number,
  matchId: string | null | undefined,
  payload: Record<string, unknown>,
  correlationId?: string
): ClientMessage {
  return {
    action: 'command',
    envelope: {
      protocolVersion: PROTOCOL_VERSION,
      messageId: newMessageId(),
      messageType,
      roomId,
      ...(matchId ? { matchId } : {}),
      revision,
      sentAt: Date.now(),
      ...(correlationId ? { correlationId } : {}),
      payload
    }
  };
}

export function parseServerEnvelope(value: unknown): ServerEnvelope | null {
  const result = ServerEnvelopeSchema.safeParse(value);
  return result.success ? result.data : null;
}
