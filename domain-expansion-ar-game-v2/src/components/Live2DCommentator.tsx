import { useEffect, useRef } from 'react';

type Live2DCore = {
  setParameterValueById?: (id: string, value: number) => void;
  setParameterValue?: (id: string, value: number) => void;
  setParamFloat?: (id: string, value: number) => void;
};

type Live2DModel = {
  anchor?: { set: (x: number, y: number) => void };
  focus?: (x: number, y: number) => void;
  getLocalBounds?: () => { x: number; y: number; width: number; height: number };
  height: number;
  internalModel: {
    coreModel?: Live2DCore;
    live2DModel?: Live2DCore;
    update: (...args: unknown[]) => void;
  };
  scale: { set: (value: number) => void };
  width: number;
  x: number;
  y: number;
};

type PixiApplication = {
  stage: { addChild: (model: Live2DModel) => void };
  destroy: (removeView?: boolean, options?: { children?: boolean; texture?: boolean; baseTexture?: boolean }) => void;
};

type PixiGlobal = {
  Application: new (options: Record<string, unknown>) => PixiApplication;
  live2d: { Live2DModel: { from: (url: string) => Promise<Live2DModel> } };
};

declare global {
  interface Window {
    PIXI?: PixiGlobal;
  }
}

const scripts = [
  'https://cdn.jsdelivr.net/npm/pixi.js@6.5.10/dist/browser/pixi.min.js',
  'https://cdn.jsdelivr.net/gh/dylanNew/live2d/webgl/Live2D/lib/live2d.min.js',
  'https://cdn.jsdelivr.net/npm/pixi-live2d-display/dist/cubism2.min.js'
];
const modelUrl = 'https://cdn.jsdelivr.net/npm/live2d-widget-model-shizuku@latest/assets/shizuku.model.json';
const mouthParameters = ['ParamMouthOpenY', 'PARAM_MOUTH_OPEN_Y', 'ParamMouthOpen', 'PARAM_MOUTH_OPEN', 'ParamA'];

function loadScript(src: string) {
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
  if (existing?.dataset.loaded === 'true') return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const script = existing ?? document.createElement('script');
    const loaded = () => {
      script.dataset.loaded = 'true';
      resolve();
    };
    script.addEventListener('load', loaded, { once: true });
    script.addEventListener('error', () => reject(new Error(`Unable to load ${src}`)), { once: true });
    if (!existing) {
      script.src = src;
      script.crossOrigin = 'anonymous';
      document.head.appendChild(script);
    }
  });
}

function setMouth(model: Live2DModel, value: number) {
  const core = model.internalModel.coreModel ?? model.internalModel.live2DModel;
  if (!core) return;
  for (const id of mouthParameters) {
    try {
      if (core.setParameterValueById) core.setParameterValueById(id, value);
      else if (core.setParameterValue) core.setParameterValue(id, value);
      else if (core.setParamFloat) core.setParamFloat(id, value);
    } catch {
      // Cubism model generations expose different mouth parameter IDs.
    }
  }
}

function fitModel(model: Live2DModel) {
  const bounds = model.getLocalBounds?.() ?? { x: 0, y: 0, width: model.width, height: model.height };
  const scale = Math.min(400 / Math.max(bounds.width, 1), 500 / Math.max(bounds.height, 1)) * .95;
  model.scale.set(scale);
  if (model.anchor) {
    model.anchor.set(.5, 1);
    model.x = 200;
    model.y = 585;
    return;
  }
  model.x = 200 - (bounds.x + bounds.width / 2) * scale;
  model.y = 500 - (bounds.y + bounds.height) * scale + 85;
}

export function Live2DCommentator({ speaking, size }: { speaking: boolean; size: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const speakingRef = useRef(speaking);
  speakingRef.current = speaking;

  useEffect(() => {
    if (!canvasRef.current || typeof WebGLRenderingContext === 'undefined') return;
    let active = true;
    let app: PixiApplication | undefined;
    let removeFocus: (() => void) | undefined;
    void (async () => {
      try {
        for (const src of scripts) await loadScript(src);
        if (!active || !canvasRef.current || !window.PIXI?.live2d) return;
        app = new window.PIXI.Application({
          view: canvasRef.current,
          transparent: true,
          backgroundAlpha: 0,
          autoStart: true,
          antialias: true,
          width: 400,
          height: 500
        });
        const model = await window.PIXI.live2d.Live2DModel.from(modelUrl);
        if (!active) return;
        app.stage.addChild(model);
        fitModel(model);
        let smoothedMouth = 0;
        const originalUpdate = model.internalModel.update.bind(model.internalModel);
        model.internalModel.update = (...args) => {
          originalUpdate(...args);
          const target = speakingRef.current
            ? Math.min((Math.sin(Date.now() * .015) * .45 + .45) + Math.random() * .2, 1)
            : 0;
          smoothedMouth += (target - smoothedMouth) * .35;
          setMouth(model, smoothedMouth);
        };
        const focus = (event: MouseEvent) => model.focus?.(event.clientX, event.clientY);
        window.addEventListener('mousemove', focus);
        removeFocus = () => window.removeEventListener('mousemove', focus);
      } catch (error) {
        console.warn('Live2D commentator failed to load', error);
      }
    })();
    return () => {
      active = false;
      removeFocus?.();
      app?.destroy(true, { children: true, texture: true, baseTexture: true });
    };
  }, []);

  return <div
    className={`live2d-avatar ${speaking ? 'speaking' : ''}`}
    style={{ width: size, height: size }}
  >
    <canvas ref={canvasRef} />
    <div className="hologram-badge">CO-HOST</div>
  </div>;
}
