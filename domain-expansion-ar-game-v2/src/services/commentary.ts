import type { Settings } from './settings';

export interface CommentaryResponse {
  commentary?: string;
  welcomeMessage?: string;
  ttsMode?: 'browser' | 'aws';
  requestedTtsMode?: 'browser' | 'aws';
  audioUrl?: string;
  voiceId?: string;
  duration?: number;
  ttsError?: string;
}

export class CommentaryPlayer {
  private audio?: HTMLAudioElement;
  private playbackFinished: Promise<void> = Promise.resolve();
  private finishPlayback: () => void = () => undefined;

  constructor(
    private readonly onSpeakingChange: (speaking: boolean) => void = () => undefined,
    private readonly onAudioChange: (audio?: HTMLAudioElement) => void = () => undefined
  ) {}

  private beginPlayback() {
    this.finishPlayback();
    let finished = false;
    let resolvePlayback: () => void = () => undefined;
    this.playbackFinished = new Promise<void>((resolve) => {
      resolvePlayback = resolve;
    });
    this.finishPlayback = () => {
      if (finished) return;
      finished = true;
      resolvePlayback();
    };
    return this.finishPlayback;
  }

  waitForPlayback() {
    return this.playbackFinished;
  }

  stop() {
    this.finishPlayback();
    this.onSpeakingChange(false);
    this.onAudioChange(undefined);
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    if (!this.audio) return;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.audio = undefined;
  }

  async play(response: CommentaryResponse, settings: Settings) {
    if (!settings.commentatorEnabled) return;
    const text = response.commentary || response.welcomeMessage || '';
    if (!text) return;
    this.stop();

    if (response.ttsMode === 'aws' && response.audioUrl) {
      this.audio = new Audio(response.audioUrl);
      const finishPlayback = this.beginPlayback();
      this.onAudioChange(this.audio);
      this.audio.volume = settings.commentaryVolume / 100;
      this.audio.onplay = () => this.onSpeakingChange(true);
      const finishAudio = () => {
        this.onSpeakingChange(false);
        this.onAudioChange(undefined);
        this.audio = undefined;
        finishPlayback();
      };
      this.audio.onended = finishAudio;
      this.audio.onerror = finishAudio;
      try {
        await this.audio.play();
        this.onSpeakingChange(true);
        return;
      } catch {
        finishPlayback();
        this.audio = undefined;
        this.onAudioChange(undefined);
        this.onSpeakingChange(false);
      }
    }

    if (!('speechSynthesis' in window)) return;
    this.onAudioChange(undefined);
    const utterance = new SpeechSynthesisUtterance(text);
    const finishPlayback = this.beginPlayback();
    utterance.lang = settings.language;
    utterance.volume = settings.commentaryVolume / 100;
    utterance.onstart = () => this.onSpeakingChange(true);
    utterance.onend = () => {
      this.onSpeakingChange(false);
      finishPlayback();
    };
    utterance.onerror = () => {
      this.onSpeakingChange(false);
      finishPlayback();
    };
    if (settings.commentaryVoice !== 'auto') {
      utterance.voice = speechSynthesis.getVoices().find(({ name }) => name === settings.commentaryVoice) ?? null;
    }
    this.onSpeakingChange(true);
    speechSynthesis.speak(utterance);
  }
}
