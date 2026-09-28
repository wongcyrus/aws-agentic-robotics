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

  constructor(
    private readonly onSpeakingChange: (speaking: boolean) => void = () => undefined,
    private readonly onAudioChange: (audio?: HTMLAudioElement) => void = () => undefined
  ) {}

  stop() {
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
      this.onAudioChange(this.audio);
      this.audio.volume = settings.commentaryVolume / 100;
      this.audio.onplay = () => this.onSpeakingChange(true);
      const finishAudio = () => {
        this.onSpeakingChange(false);
        this.onAudioChange(undefined);
        this.audio = undefined;
      };
      this.audio.onended = finishAudio;
      this.audio.onerror = finishAudio;
      try {
        await this.audio.play();
        return;
      } catch {
        this.audio = undefined;
        this.onAudioChange(undefined);
      }
    }

    if (!('speechSynthesis' in window)) return;
    this.onAudioChange(undefined);
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = settings.language;
    utterance.volume = settings.commentaryVolume / 100;
    utterance.onstart = () => this.onSpeakingChange(true);
    utterance.onend = () => this.onSpeakingChange(false);
    utterance.onerror = () => this.onSpeakingChange(false);
    if (settings.commentaryVoice !== 'auto') {
      utterance.voice = speechSynthesis.getVoices().find(({ name }) => name === settings.commentaryVoice) ?? null;
    }
    speechSynthesis.speak(utterance);
  }
}
