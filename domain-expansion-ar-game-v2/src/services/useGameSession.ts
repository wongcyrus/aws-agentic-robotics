import { useCallback, useEffect, useRef, useState } from 'react';
import { acceptState } from '../core/match';
import {
  createCommand, type CommandType, type MatchState, type Role,
  type ServerEnvelope, type WebRtcPayload, type WebRtcSignalType
} from '../core/protocol';
import { LocalStorageTokenProvider } from './auth';
import { loadConfig, type AppConfig } from './config';
import { WebSocketControlTransport } from './controlTransport';

const clientIdFor = (roomId: string, role: Role) => {
  const key = `domain-expansion-v2.client.${roomId}.${role}`;
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = globalThis.crypto?.randomUUID?.() ?? `client_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem(key, id);
  }
  return id;
};

export function useGameSession(roomId: string, role: Role) {
  const [state, setState] = useState<MatchState | null>(null);
  const [status, setStatus] = useState('loading');
  const [config, setConfig] = useState<AppConfig | null>(null);
  const transport = useRef<WebSocketControlTransport | null>(null);
  const listeners = useRef(new Set<(message: ServerEnvelope) => void>());
  const stateRef = useRef<MatchState | null>(null);
  stateRef.current = state;

  useEffect(() => {
    let active = true;
    loadConfig().then((loaded) => {
      if (!active) return;
      setConfig(loaded);
      const control = new WebSocketControlTransport(loaded.webSocketUrl, new LocalStorageTokenProvider());
      transport.current = control;
      control.subscribe((message) => {
        listeners.current.forEach((listener) => listener(message));
        if (message.messageType === 'room.snapshot') {
          setState((current) => acceptState(current, message.payload.state));
        }
        if (message.messageType === 'command.rejected') setStatus(`rejected: ${message.payload.reason}`);
      });
      control.subscribeStatus((nextStatus) => {
        setStatus(nextStatus);
        if (nextStatus === 'connected') {
          control.send({ action: 'join', roomId, role, clientId: clientIdFor(roomId, role) });
        }
      });
      control.connect();
    });
    return () => { active = false; transport.current?.close(); transport.current = null; };
  }, [roomId, role]);

  const command = useCallback((messageType: CommandType, payload: Record<string, unknown> = {}, correlationId?: string) => {
    const current = stateRef.current;
    transport.current?.send(createCommand(messageType, roomId, current?.revision ?? 0, current?.matchId, payload, correlationId));
  }, [roomId]);
  const signal = useCallback((signalType: WebRtcSignalType, payload: WebRtcPayload = {}, to?: string) => {
    transport.current?.send({ action: 'signal', roomId, ...(to ? { to } : {}), signalType, payload });
  }, [roomId]);
  const subscribe = useCallback((listener: (message: ServerEnvelope) => void) => {
    listeners.current.add(listener);
    return () => { listeners.current.delete(listener); };
  }, []);
  return { state, status, config, command, signal, subscribe };
}
