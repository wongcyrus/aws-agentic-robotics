import { getGesture, type GestureName } from '../core/catalog';
import type { Landmark } from './gestureRecognizer';

type LegacyVfxEngine = {
  initVFX(canvas: HTMLCanvasElement): void;
  drawVFX(
    canvas: HTMLCanvasElement,
    gesture: GestureName | null,
    hands: Landmark[][]
  ): void;
};

declare global {
  interface Window {
    DomainExpansionGame?: new () => LegacyVfxEngine;
  }
}

let legacyScript: Promise<void> | undefined;
function loadLegacyVfx() {
  legacyScript ??= new Promise<void>((resolve, reject) => {
    if (window.DomainExpansionGame) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = '/legacy/domain_expansion.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Unable to load the V1 VFX engine'));
    document.head.appendChild(script);
  });
  return legacyScript;
}

function imageDimensions(image: CanvasImageSource, fallbackWidth: number, fallbackHeight: number) {
  if (image instanceof HTMLVideoElement && image.videoWidth && image.videoHeight) {
    return { width: image.videoWidth, height: image.videoHeight };
  }
  if (image instanceof HTMLImageElement && image.naturalWidth && image.naturalHeight) {
    return { width: image.naturalWidth, height: image.naturalHeight };
  }
  if ('width' in image && 'height' in image && Number(image.width) > 0 && Number(image.height) > 0) {
    return { width: Number(image.width), height: Number(image.height) };
  }
  return { width: fallbackWidth, height: fallbackHeight };
}

export class CanvasVfxAdapter {
  private engine?: LegacyVfxEngine;
  private readonly effectsCanvas = document.createElement('canvas');

  async initialize() {
    await loadLegacyVfx();
    if (!window.DomainExpansionGame) {
      throw new Error('V1 VFX engine is unavailable');
    }
    this.engine = new window.DomainExpansionGame();
    this.engine.initVFX(this.effectsCanvas);
  }

  draw(
    canvas: HTMLCanvasElement,
    image: CanvasImageSource,
    hands: Landmark[][],
    active: GestureName | null
  ) {
    const dimensions = imageDimensions(
      image,
      canvas.clientWidth || 1280,
      canvas.clientHeight || 720
    );
    const { width, height } = dimensions;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const effectsWidth = canvas.clientWidth || width;
    const effectsHeight = canvas.clientHeight || height;
    if (this.effectsCanvas.width !== effectsWidth || this.effectsCanvas.height !== effectsHeight) {
      this.effectsCanvas.width = effectsWidth;
      this.effectsCanvas.height = effectsHeight;
      this.engine?.initVFX(this.effectsCanvas);
    }
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, width, height);
    context.save();
    context.translate(width, 0);
    context.scale(-1, 1);
    context.drawImage(image, 0, 0, width, height);
    context.restore();

    hands.forEach((hand) => {
      context.strokeStyle = getGesture(active)?.color ?? '#55ddff';
      context.lineWidth = 3;
      hand.forEach((point) => {
        context.beginPath();
        context.arc((1 - point.x) * width, point.y * height, 4, 0, Math.PI * 2);
        context.stroke();
      });
    });

    if (this.engine) {
      this.engine.drawVFX(this.effectsCanvas, active, hands);
      context.save();
      context.translate(width, 0);
      context.scale(-1, 1);
      context.drawImage(this.effectsCanvas, 0, 0, width, height);
      context.restore();
    }
  }
}
