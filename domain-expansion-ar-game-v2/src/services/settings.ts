import { z } from 'zod';
import type { PlayerRole } from '../core/protocol';

const SettingsSchema = z.object({
  roomCode: z.string().regex(/^[A-Z0-9]{4,12}$/),
  role: z.enum(['player1', 'player2']),
  cameraId: z.string(),
  language: z.enum(['zh-HK', 'zh-TW', 'en', 'ja']),
  robotId: z.string(),
  disableRobotApi: z.boolean(),
  videoMode: z.enum(['integrated', 'popup', 'none']),
  difficulty: z.number().int().min(3).max(15),
  gestureCount: z.number().int().min(1).max(11)
});
export type Settings = z.infer<typeof SettingsSchema>;
const key = 'domain-expansion-v2.settings';
export const defaultSettings: Settings = {
  roomCode: 'BTL1', role: 'player1', cameraId: 'default', language: 'zh-HK',
  robotId: 'all', disableRobotApi: false, videoMode: 'integrated', difficulty: 8, gestureCount: 11
};

export function loadSettings(overrides: Partial<Settings> = {}): Settings {
  let stored: unknown = {};
  try { stored = JSON.parse(localStorage.getItem(key) ?? '{}'); } catch { stored = {}; }
  const result = SettingsSchema.safeParse({ ...defaultSettings, ...(stored as object), ...overrides });
  return result.success ? result.data : defaultSettings;
}
export function saveSettings(settings: Settings) { localStorage.setItem(key, JSON.stringify(SettingsSchema.parse(settings))); }
export const roleLabel = (role: PlayerRole) => role === 'player1' ? 'Player 1' : 'Player 2';
