import type { PlayerRole } from '../core/protocol';
import type { TokenProvider } from './auth';
import type { CommentaryResponse } from './commentary';

export class ApiClient {
  constructor(private readonly baseUrl: string, private readonly tokens: TokenProvider) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = this.tokens.getIdToken();
    const headers = new Headers(init.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, { ...init, headers });
    if (!response.ok) throw new Error(`API ${response.status}: ${await response.text()}`);
    const contentType = response.headers.get('content-type') ?? '';
    return (contentType.includes('json') ? response.json() : response.blob()) as Promise<T>;
  }

  triggerTechnique(robotId: string, technique: string, sessionKey: string) {
    return this.request('/api/trigger-technique', { method: 'POST', body: JSON.stringify({ robotId, technique, sessionKey }) });
  }
  registerRoom(sessionId: string, roomCode: string, signalingUrl: string) {
    return this.request('/api/register-room', {
      method: 'POST',
      body: JSON.stringify({ sessionId, roomCode, signalingUrl })
    });
  }
  commentary(path: '/api/live-status' | '/api/battle-result', body: Record<string, unknown>) {
    return this.request<CommentaryResponse>(path, { method: 'POST', body: JSON.stringify(body) });
  }
  uploadSnapshot(sessionId: string, role: PlayerRole, phase: 'START' | 'END', image: string) {
    return this.request('/api/webcam-upload', { method: 'POST', body: JSON.stringify({ sessionId, role, phase, image }) });
  }
  getSnapshot(sessionId: string, role: PlayerRole) {
    return this.request<{ success: boolean; image?: string; message?: string }>(
      `/api/get-snapshot?sessionId=${encodeURIComponent(sessionId)}&role=${role}`
    );
  }
}
