import type { GestureName } from '../core/catalog';
import type { PlayerRole } from '../core/protocol';
import type { TokenProvider } from './auth';

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
  commentary(path: '/api/live-status' | '/api/battle-result', body: Record<string, unknown>) {
    return this.request<{ commentary?: string; audio?: string }>(path, { method: 'POST', body: JSON.stringify(body) });
  }
  uploadSnapshot(sessionId: string, role: PlayerRole, phase: 'START' | 'END', image: string) {
    return this.request('/api/webcam-upload', { method: 'POST', body: JSON.stringify({ sessionId, role, phase, image }) });
  }
  snapshotUrl(sessionId: string, role: PlayerRole) {
    return `${this.baseUrl.replace(/\/$/, '')}/api/get-snapshot?sessionId=${encodeURIComponent(sessionId)}&role=${role}`;
  }
  enhancePortrait(sessionId: string, winner: PlayerRole | 'draw', domain?: GestureName | null) {
    return this.request<{ jobId?: string; imageUrl?: string }>('/api/enhance-portrait', {
      method: 'POST', body: JSON.stringify({ sessionId, winner, domain })
    });
  }
  checkEnhancement(sessionId: string) {
    return this.request<{ status: string; imageUrl?: string }>(`/api/check-enhancement?sessionId=${encodeURIComponent(sessionId)}`);
  }
}
