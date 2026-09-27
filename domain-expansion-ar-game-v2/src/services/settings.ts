import { z } from 'zod';
import type { PlayerRole } from '../core/protocol';

const SettingsSchema = z.object({
  roomCode: z.string().regex(/^[A-Z0-9]{4,12}$/),
  role: z.enum(['player1', 'player2']),
  playerMode: z.enum(['battle', 'solo']),
  cameraId: z.string(),
  language: z.enum(['zh-HK', 'zh-TW', 'en', 'ja']),
  robotId: z.string(),
  disableRobotApi: z.boolean(),
  robotCooldownSeconds: z.number().int().min(1).max(30),
  videoMode: z.enum(['integrated', 'integrated_silent', 'popup', 'none']),
  autoOpenPopup: z.boolean(),
  difficulty: z.number().int().min(3).max(15),
  gestureCount: z.number().int().min(1).max(11),
  countdownSeconds: z.number().int().min(0).max(10),
  scoreGraceMs: z.number().int().min(0).max(5000),
  synchronizedGestures: z.boolean(),
  layout: z.enum(['side-by-side', 'vertical-stack']),
  dynamicView: z.boolean(),
  commentatorEnabled: z.boolean(),
  commentaryEngine: z.enum(['strands_local', 'agentcore_runtime', 'openclaw']),
  commentaryTtsMode: z.enum(['browser', 'aws']),
  commentaryVoice: z.string(),
  commentaryVolume: z.number().int().min(0).max(100),
  commentatorWebcam: z.boolean(),
  commentatorImagePolicy: z.enum(['always', 'start_end', 'never']),
  foulLanguage: z.boolean(),
  aiPortraitEnabled: z.boolean(),
  avatarSize: z.number().int().min(150).max(700)
});
export type Settings = z.infer<typeof SettingsSchema>;
const key = 'domain-expansion-v2.settings';
export const defaultSettings: Settings = {
  roomCode: 'BTL1',
  role: 'player1',
  playerMode: 'battle',
  cameraId: 'default',
  language: 'zh-HK',
  robotId: 'all',
  disableRobotApi: false,
  robotCooldownSeconds: 10,
  videoMode: 'integrated',
  autoOpenPopup: false,
  difficulty: 8,
  gestureCount: 11,
  countdownSeconds: 3,
  scoreGraceMs: 1000,
  synchronizedGestures: false,
  layout: 'side-by-side',
  dynamicView: true,
  commentatorEnabled: true,
  commentaryEngine: 'openclaw',
  commentaryTtsMode: 'aws',
  commentaryVoice: 'auto',
  commentaryVolume: 100,
  commentatorWebcam: true,
  commentatorImagePolicy: 'start_end',
  foulLanguage: false,
  aiPortraitEnabled: true,
  avatarSize: 350
};

export function loadSettings(overrides: Partial<Settings> = {}): Settings {
  let stored: unknown = {};
  try { stored = JSON.parse(localStorage.getItem(key) ?? '{}'); } catch { stored = {}; }
  const result = SettingsSchema.safeParse({ ...defaultSettings, ...(stored as object), ...overrides });
  return result.success ? result.data : defaultSettings;
}
export function saveSettings(settings: Settings) { localStorage.setItem(key, JSON.stringify(SettingsSchema.parse(settings))); }
export const roleLabel = (role: PlayerRole) => role === 'player1' ? 'Player 1' : 'Player 2';
