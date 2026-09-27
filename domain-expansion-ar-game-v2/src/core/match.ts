import type { GestureName } from './catalog';
import type { MatchState, PlayerRole } from './protocol';

export const remainingSeconds = (deadlineMs: number | null | undefined, now = Date.now()) =>
  deadlineMs == null ? 0 : Math.max(0, Math.ceil((deadlineMs - now) / 1000));

export function targetFor(state: MatchState, role: PlayerRole): GestureName | null {
  return state.players[role].challenge?.technique ?? null;
}

export function deadlineFor(state: MatchState, role: PlayerRole): number | null {
  return state.players[role].challenge?.deadlineAt ?? null;
}

export function acceptState(current: MatchState | null, incoming: MatchState): MatchState {
  return !current || incoming.revision > current.revision ? incoming : current;
}
