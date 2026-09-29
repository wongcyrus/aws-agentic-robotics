import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { detectGesture, StableGestureRecognizer, type Landmark } from '../adapters/gestureRecognizer';
import { MediaPipeCameraAdapter } from '../adapters/mediaPipeCamera';
import { CanvasVfxAdapter } from '../adapters/vfx';

const hand = (): Landmark[] => Array.from({ length: 21 }, (_, index) => ({
  x: index * .01, y: .5, z: 0
}));
const extended = (indices: number[]) => {
  const value = hand();
  for (const [mcp, pip, tip] of [[5, 6, 8], [9, 10, 12], [13, 14, 16], [17, 18, 20]]) {
    value[mcp] = { x: mcp * .01, y: .5 };
    value[pip] = { x: mcp * .01, y: .4 };
    value[tip] = indices.includes(tip) ? { x: mcp * .01, y: .15 } : { x: mcp * .01, y: .48 };
  }
  return value;
};
const timeCellHand = (x: number) => {
  const value = hand();
  value[0] = { x, y: .6 };
  value[4] = { x: x - .08, y: .35 };
  value[5] = { x: x + .02, y: .5 };
  value[6] = { x: x + .02, y: .4 };
  value[8] = { x: x + .02, y: .2 };
  for (const [mcp, pip, tip] of [[9, 10, 12], [13, 14, 16], [17, 18, 20]]) {
    value[mcp] = { x: x + mcp * .002, y: .5 };
    value[pip] = { x: x + mcp * .002, y: .48 };
    value[tip] = { x: x + mcp * .002, y: .55 };
  }
  return value;
};

describe('gesture recognition', () => {
  it('recognizes single and combined techniques', () => {
    const blue = extended([8]);
    const red = extended([8, 12, 16]);
    expect(detectGesture([])).toBeNull();
    expect(detectGesture([blue])).toBe('Lapse Blue');
    expect(detectGesture([red])).toBe('Reversal Red');
    expect(detectGesture([blue, red])).toBe('Hollow Purple');
  });

  it('recognizes closed-hand paired techniques and stabilizes results', () => {
    const first = extended([]);
    const second = extended([]);
    first[0] = { x: .4, y: .5 };
    second[0] = { x: .5, y: .52 };
    expect(detectGesture([first, second])).toBe('Chimera Shadow Garden');
    const recognizer = new StableGestureRecognizer();
    for (let index = 0; index < 5; index++) expect(recognizer.update([extended([8])])).toBeNull();
    expect(recognizer.update([extended([8])])).toBe('Lapse Blue');
    for (let index = 0; index < 6; index++) recognizer.update([]);
    expect(recognizer.update([])).toBeNull();
  });

  it('recognizes and stabilizes Time Cell Moon Palace', () => {
    const hands = [timeCellHand(.35), timeCellHand(.65)];
    expect(detectGesture(hands)).toBe('Time Cell Moon Palace');
    const recognizer = new StableGestureRecognizer();
    for (let index = 0; index < 5; index++) expect(recognizer.update(hands)).toBeNull();
    expect(recognizer.update(hands)).toBe('Time Cell Moon Palace');
  });
});

describe('browser adapters', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 9));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  it('starts MediaPipe, forwards frames, and stops tracks', async () => {
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
    const send = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    let results: (result: { image: CanvasImageSource; multiHandLandmarks?: Landmark[][] }) => void = () => undefined;
    class Hands {
      setOptions = vi.fn();
      onResults(callback: typeof results) { results = callback; }
      send = send;
      close = close;
    }
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) }
    });
    const video = document.createElement('video');
    const adapter = new MediaPipeCameraAdapter();
    const started = adapter.start(video, 'camera-1', vi.fn());
    const script = document.querySelector('script')!;
    window.Hands = Hands as never;
    script.onload?.(new Event('load'));
    await expect(started).resolves.toBe(stream);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith(expect.objectContaining({
      video: expect.objectContaining({ deviceId: { exact: 'camera-1' } })
    }));
    results({ image: video, multiHandLandmarks: [hand()] });
    adapter.stop();
    expect(close).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(9);
  });

  it('loads and draws through the legacy VFX engine', async () => {
    const initVFX = vi.fn(), drawVFX = vi.fn();
    window.DomainExpansionGame = undefined;
    const adapter = new CanvasVfxAdapter();
    const initialized = adapter.initialize();
    const script = document.querySelector<HTMLScriptElement>('script[src="/legacy/domain_expansion.js"]')!;
    window.DomainExpansionGame = class { initVFX = initVFX; drawVFX = drawVFX; };
    script.onload?.(new Event('load'));
    await initialized;
    const context = {
      clearRect: vi.fn(), save: vi.fn(), translate: vi.fn(), scale: vi.fn(),
      drawImage: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), stroke: vi.fn(),
      strokeStyle: '', lineWidth: 0
    };
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const canvas = document.createElement('canvas');
    Object.defineProperty(canvas, 'clientWidth', { value: 640 });
    Object.defineProperty(canvas, 'clientHeight', { value: 360 });
    const video = document.createElement('video');
    Object.defineProperty(video, 'videoWidth', { value: 1024 });
    Object.defineProperty(video, 'videoHeight', { value: 768 });
    adapter.draw(canvas, video, [[{ x: .2, y: .3 }]], 'Hollow Purple');
    expect(canvas.width).toBe(1024);
    expect(canvas.height).toBe(768);
    expect(initVFX).toHaveBeenLastCalledWith(expect.objectContaining({ width: 640, height: 360 }));
    expect(context.drawImage).toHaveBeenCalledWith(video, 0, 0, 1024, 768);
    expect(context.arc).toHaveBeenCalled();
    expect(drawVFX).toHaveBeenCalledWith(expect.any(HTMLCanvasElement), 'Hollow Purple', expect.any(Array));
  });

  it('keeps the original Hollow Purple two-hand merge sequence', () => {
    const source = readFileSync(resolve('public/legacy/domain_expansion.js'), 'utf8');
    const effect = source.match(/applyHollowPurple\(ctx, p1, p2, w, h\) \{([\s\S]*?)\n    \}\n\}/)?.[1];
    expect(effect).toBeDefined();
    expect(effect).toContain('if (dist < 200)');
    expect(effect).toContain('this.applyLapseBlue(ctx, p1)');
    expect(effect).toContain('this.applyReversalRed(ctx, p2)');
    expect(effect?.indexOf('if (dist < 200)')).toBeLessThan(effect?.indexOf('this.applyLapseBlue(ctx, p1)') ?? -1);
  });

  it('does not render numeric glyphs in the Unlimited Void effect', () => {
    const source = readFileSync(resolve('public/legacy/domain_expansion.js'), 'utf8');
    const effect = source.match(/applyUnlimitedVoid\(ctx, w, h\) \{([\s\S]*?)\n    \}\n\n    applyMalevolentShrine/)?.[1];
    expect(effect).toBeDefined();
    expect(effect).not.toContain('fillText');
    expect(effect).not.toContain('symbols');
  });

  it('pre-mirrors Idle Death Gamble numbers for the mirrored VFX composite', () => {
    const source = readFileSync(resolve('public/legacy/domain_expansion.js'), 'utf8');
    const effect = source.match(/applyIdleDeathGamble\(ctx, w, h\) \{([\s\S]*?)\n    \}\n\n    applyYujiDomain/)?.[1];
    expect(effect).toBeDefined();
    expect(effect).toMatch(/ctx\.translate\(w, 0\);\s*ctx\.scale\(-1, 1\);[\s\S]*?ctx\.fillText/);
  });
});
