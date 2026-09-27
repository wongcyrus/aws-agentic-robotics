export const gestures = [
  { id: 'unlimited_void', name: 'Unlimited Void', color: '#eaf7ff', video: '/static/video/domain_unlimited_void.mp4', robotTechnique: 'domain_unlimited_void' },
  { id: 'malevolent_shrine', name: 'Malevolent Shrine', color: '#ff3030', video: '/static/video/domain_malevolent_shrine.mp4', robotTechnique: 'domain_malevolent_shrine' },
  { id: 'self_embodiment', name: 'Self-Embodiment of Perfection', color: '#b24cff', video: '/static/video/domain_self_embodiment.mp4', robotTechnique: 'domain_self_embodiment' },
  { id: 'authentic_love', name: 'Authentic Mutual Love', color: '#ee82ee', video: '/static/video/domain_authentic_love.mp4', robotTechnique: 'domain_authentic_love' },
  { id: 'idle_death_gamble', name: 'Idle Death Gamble', color: '#ffd700', video: '/static/video/domain_idle_death_gamble.mp4', robotTechnique: 'domain_idle_death_gamble' },
  { id: 'yuji_itadori', name: 'Yuji Itadori', color: '#45ff75', video: '/static/video/domain_yuji_itadori.mp4', robotTechnique: 'domain_yuji_itadori' },
  { id: 'chimera_garden', name: 'Chimera Shadow Garden', color: '#6574ff', video: '/static/video/domain_chimera_shadow_garden.mp4', robotTechnique: 'domain_chimera_shadow_garden' },
  { id: 'time_cell', name: 'Time Cell Moon Palace', color: '#ff69b4', video: '/static/video/domain_time_cell_moon_palace.mp4', robotTechnique: 'domain_time_cell_moon_palace' },
  { id: 'lapse_blue', name: 'Lapse Blue', color: '#238cff', video: '/static/video/technique_lapse_blue.mp4', robotTechnique: 'lapse_blue' },
  { id: 'reversal_red', name: 'Reversal Red', color: '#ff4500', video: '/static/video/technique_reversal_red.mp4', robotTechnique: 'reversal_red' },
  { id: 'hollow_purple', name: 'Hollow Purple', color: '#a855f7', video: '/static/video/technique_hollow_purple.mp4', robotTechnique: 'hollow_purple' }
] as const;

export type GestureName = (typeof gestures)[number]['name'];
export const gestureNames = gestures.map(({ name }) => name) as GestureName[];
export const getGesture = (name?: string | null) => gestures.find((gesture) => gesture.name === name);

export function shuffledGestures(count: number, random = Math.random): GestureName[] {
  return [...gestureNames].sort(() => random() - 0.5).slice(0, Math.max(1, Math.min(count, gestures.length)));
}
