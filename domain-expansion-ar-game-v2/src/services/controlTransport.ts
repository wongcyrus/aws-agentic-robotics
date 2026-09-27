import { ClientMessageSchema, parseServerEnvelope, type ClientMessage, type ServerEnvelope } from '../core/protocol';
import type { TokenProvider } from './auth';

type Listener = (message: ServerEnvelope) => void;
type StatusListener = (status: 'connecting' | 'connected' | 'disconnected') => void;
export class WebSocketControlTransport {
  private socket?: WebSocket;
  private reconnect?: number;
  private heartbeat?: number;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private stopped = false;

  constructor(private readonly url: string, private readonly tokens: TokenProvider) {}
  subscribe(listener: Listener) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  subscribeStatus(listener: StatusListener) { this.statusListeners.add(listener); return () => { this.statusListeners.delete(listener); }; }
  private status(value: Parameters<StatusListener>[0]) { this.statusListeners.forEach((listener) => listener(value)); }
  connect() {
    this.stopped = false;
    this.status('connecting');
    const url = new URL(this.url, location.href);
    const token = this.tokens.getIdToken();
    if (token) url.searchParams.set('token', token);
    this.socket = new WebSocket(url);
    this.socket.onopen = () => {
      this.status('connected');
      this.heartbeat = window.setInterval(() => this.send({ action: 'ping' }), 30_000);
    };
    this.socket.onmessage = ({ data }) => {
      try {
        const parsed = parseServerEnvelope(JSON.parse(String(data)));
        if (parsed) this.listeners.forEach((listener) => listener(parsed));
      } catch (error) { console.warn('Rejected control envelope', error); }
    };
    this.socket.onclose = () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.status('disconnected');
      if (!this.stopped) this.reconnect = window.setTimeout(() => this.connect(), 2_000);
    };
  }
  send(message: ClientMessage) {
    const valid = ClientMessageSchema.parse(message);
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('Control WebSocket is not connected');
    this.socket.send(JSON.stringify(valid));
  }
  close() {
    this.stopped = true;
    if (this.reconnect) clearTimeout(this.reconnect);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.close();
  }
}
