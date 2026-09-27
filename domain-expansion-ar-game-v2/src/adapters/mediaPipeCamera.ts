import type { Landmark } from './gestureRecognizer';

declare global {
  interface Window {
    Hands?: new (options: { locateFile: (file: string) => string }) => {
      setOptions(options: object): void;
      onResults(callback: (result: { image: CanvasImageSource; multiHandLandmarks?: Landmark[][] }) => void): void;
      send(input: { image: HTMLVideoElement }): Promise<void>;
      close(): Promise<void>;
    };
  }
}

const loadScript = (src: string) => new Promise<void>((resolve, reject) => {
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
  if (existing) return resolve();
  const script = document.createElement('script');
  script.src = src; script.crossOrigin = 'anonymous'; script.onload = () => resolve(); script.onerror = () => reject(new Error(`Unable to load ${src}`));
  document.head.appendChild(script);
});

export class MediaPipeCameraAdapter {
  private stream?: MediaStream;
  private hands?: InstanceType<NonNullable<typeof window.Hands>>;
  private frame?: number;
  async start(video: HTMLVideoElement, cameraId: string, onFrame: (image: CanvasImageSource, hands: Landmark[][]) => void) {
    await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js');
    if (!window.Hands) throw new Error('MediaPipe Hands did not load');
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: cameraId === 'default' ? undefined : { exact: cameraId }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false
    });
    video.srcObject = this.stream;
    await video.play();
    this.hands = new window.Hands({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}` });
    this.hands.setOptions({ maxNumHands: 2, modelComplexity: 1, minDetectionConfidence: .65, minTrackingConfidence: .6 });
    this.hands.onResults((result) => onFrame(result.image, result.multiHandLandmarks ?? []));
    const loop = async () => {
      if (!this.hands) return;
      await this.hands.send({ image: video });
      this.frame = requestAnimationFrame(loop);
    };
    loop();
    return this.stream;
  }
  stop() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.hands?.close();
    this.hands = undefined;
    this.stream?.getTracks().forEach((track) => track.stop());
  }
}
