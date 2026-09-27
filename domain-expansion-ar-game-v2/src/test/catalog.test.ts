import { describe, expect, it } from 'vitest';
import { gestureLabel, gestures, shuffledGestures } from '../core/catalog';

describe('gesture catalog', () => {
  it('keeps all techniques unique and mapped to media and robot actions', () => {
    expect(gestures).toHaveLength(11);
    expect(new Set(gestures.map(({ name }) => name)).size).toBe(11);
    expect(gestures.every(({ video, robotTechnique }) => video.endsWith('.mp4') && robotTechnique.length > 0)).toBe(true);
  });
  it('clamps requested match size', () => {
    expect(shuffledGestures(99, () => .5)).toHaveLength(11);
    expect(shuffledGestures(0, () => .5)).toHaveLength(1);
  });
  it('localizes gesture labels without changing protocol names', () => {
    expect(gestureLabel('Hollow Purple', 'zh-HK')).toBe('虛式・茈');
    expect(gestureLabel('Hollow Purple', 'en')).toBe('Hollow Purple');
  });
});
