import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketControlTransport } from '../services/controlTransport';
import { WebRtcSessionService } from '../services/webrtcSession';

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.OPEN;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  send = vi.fn();
  close = vi.fn(() => this.onclose?.());
  constructor(public url: URL) { FakeSocket.instances.push(this); }
}

class FakePeer {
  connectionState = 'new';
  signalingState = 'stable';
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate?: (event: { candidate: RTCIceCandidate | null }) => void;
  ontrack?: (event: { streams: MediaStream[] }) => void;
  onconnectionstatechange?: () => void;
  senders: { track: MediaStreamTrack }[] = [];
  addIceCandidate = vi.fn().mockResolvedValue(undefined);
  addTrack = vi.fn((track: MediaStreamTrack) => this.senders.push({ track }));
  getSenders = vi.fn(() => this.senders);
  createOffer = vi.fn().mockResolvedValue({ type: 'offer', sdp: 'offer-sdp' });
  createAnswer = vi.fn().mockResolvedValue({ type: 'answer', sdp: 'answer-sdp' });
  setLocalDescription = vi.fn().mockResolvedValue(undefined);
  setRemoteDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.remoteDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
  });
  close = vi.fn(() => { this.connectionState = 'closed'; });
}

describe('WebSocket control transport', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket);
  });

  it('connects, authenticates, parses messages, sends and closes', () => {
    vi.useFakeTimers();
    const transport = new WebSocketControlTransport('wss://socket.test/control', { getIdToken: () => 'id token' });
    const statuses: string[] = [];
    const messages: string[] = [];
    const unsubscribe = transport.subscribe((message) => messages.push(message.messageType));
    transport.subscribeStatus((status) => statuses.push(status));
    transport.connect();
    const socket = FakeSocket.instances[0];
    expect(socket.url.searchParams.get('token')).toBe('id token');
    socket.onopen?.();
    socket.onmessage?.({ data: JSON.stringify({
      protocolVersion: '2.0', messageId: '1', messageType: 'command.acknowledged',
      roomId: 'ROOM', revision: 1, sentAt: 1, payload: {}
    }) });
    expect(statuses).toEqual(['connecting', 'connected']);
    expect(messages).toEqual(['command.acknowledged']);
    transport.send({ action: 'ping' });
    expect(socket.send).toHaveBeenCalledWith('{"action":"ping"}');
    unsubscribe();
    transport.close();
    expect(socket.close).toHaveBeenCalled();
  });

  it('rejects sends while disconnected and schedules reconnects', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const transport = new WebSocketControlTransport('/control', { getIdToken: () => null });
    expect(() => transport.send({ action: 'ping' })).toThrow('not connected');
    transport.connect();
    const socket = FakeSocket.instances[0];
    socket.readyState = 0;
    expect(() => transport.send({ action: 'ping' })).toThrow('not connected');
    socket.onmessage?.({ data: '{bad' });
    expect(warn).toHaveBeenCalledWith('Rejected control envelope', expect.any(SyntaxError));
    socket.onclose?.();
    vi.advanceTimersByTime(2000);
    expect(FakeSocket.instances).toHaveLength(2);
    transport.close();
  });
});

describe('WebRTC session service', () => {
  beforeEach(() => vi.stubGlobal('RTCPeerConnection', FakePeer));

  it('offers a local stream, emits ICE, and removes failed peers', async () => {
    const send = vi.fn();
    const track = {} as MediaStreamTrack;
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    const service = new WebRtcSessionService('player1', send, vi.fn());
    service.playerReady();
    service.viewerRequested('viewer');
    await service.handle('viewerRequested', {}, 'viewer', 'viewer', stream);
    const peer = (vi.mocked(RTCPeerConnection).mock?.instances?.[0] ?? undefined) as unknown as FakePeer | undefined;
    const actualPeer = peer ?? (service as unknown as { peers: Map<string, FakePeer> }).peers.get('viewer')!;
    expect(actualPeer.addTrack).toHaveBeenCalledWith(track, stream);
    expect(send).toHaveBeenCalledWith('offer', { sdp: 'offer-sdp' }, 'viewer');
    actualPeer.onicecandidate?.({ candidate: { candidate: 'ice', sdpMid: '0', sdpMLineIndex: 0 } as RTCIceCandidate });
    expect(send).toHaveBeenCalledWith('iceCandidate', expect.objectContaining({ candidate: 'ice' }), 'viewer');
    actualPeer.connectionState = 'failed';
    actualPeer.onconnectionstatechange?.();
    expect(actualPeer.close).toHaveBeenCalled();
  });

  it('queues ICE, answers offers, accepts answers and closes peers', async () => {
    const send = vi.fn();
    const onStream = vi.fn();
    const viewer = new WebRtcSessionService('viewer', send, onStream);
    await viewer.handle('playerReady', {}, 'player', 'player1');
    expect(send).toHaveBeenCalledWith('viewerRequested', {}, 'player');
    await viewer.handle('iceCandidate', { candidate: 'queued' }, 'player', 'player1');
    const peer = (viewer as unknown as { peers: Map<string, FakePeer> }).peers.get('player')!;
    expect(peer.addIceCandidate).not.toHaveBeenCalled();
    await viewer.handle('offer', { sdp: 'offer' }, 'player', 'player1');
    expect(peer.addIceCandidate).toHaveBeenCalledWith(expect.objectContaining({ candidate: 'queued' }));
    expect(send).toHaveBeenCalledWith('answer', { sdp: 'answer-sdp' }, 'player');
    peer.ontrack?.({ streams: [{} as MediaStream] });
    expect(onStream).toHaveBeenCalledWith('player1', expect.anything());

    const player = new WebRtcSessionService('player1', send, onStream);
    await player.handle('iceCandidate', { candidate: 'direct' }, 'viewer', 'viewer');
    const answerPeer = (player as unknown as { peers: Map<string, FakePeer> }).peers.get('viewer')!;
    answerPeer.remoteDescription = { type: 'offer', sdp: 'x' };
    answerPeer.signalingState = 'have-local-offer';
    await player.handle('answer', { sdp: 'answer' }, 'viewer', 'viewer');
    await player.handle('peerClosed', {}, 'viewer', 'viewer');
    expect(answerPeer.close).toHaveBeenCalled();
    viewer.close();
    expect(send).toHaveBeenCalledWith('peerClosed', {});
  });
});

describe('game session hook', () => {
  it('joins, accepts snapshots, sends commands and signals', async () => {
    vi.resetModules();
    const send = vi.fn(), connect = vi.fn(), close = vi.fn();
    let messageListener: (message: unknown) => void = () => undefined;
    let statusListener: (status: string) => void = () => undefined;
    vi.doMock('../services/config', () => ({
      loadConfig: () => Promise.resolve({ webSocketUrl: 'wss://socket', apiBaseUrl: '' })
    }));
    vi.doMock('../services/controlTransport', () => ({
      WebSocketControlTransport: class {
        subscribe(listener: typeof messageListener) { messageListener = listener; return vi.fn(); }
        subscribeStatus(listener: typeof statusListener) { statusListener = listener; return vi.fn(); }
        send = send; connect = connect; close = close;
      }
    }));
    const { useGameSession } = await import('../services/useGameSession');
    const { result, unmount } = renderHook(() => useGameSession('ROOM', 'viewer'));
    await waitFor(() => expect(connect).toHaveBeenCalled());
    const beforeSync = Date.now();
    expect(result.current.serverTime(beforeSync)).toBe(beforeSync);
    act(() => statusListener('connected'));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ action: 'join', roomId: 'ROOM', role: 'viewer' }));
    act(() => result.current.command('match.reset', { reason: 'test' }, 'corr'));
    act(() => result.current.signal('viewerRequested', {}, 'player'));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ action: 'command' }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ action: 'signal', to: 'player' }));
    const receivedAt = Date.now();
    act(() => messageListener({
      messageType: 'command.rejected', sentAt: receivedAt + 5_000, payload: { reason: 'late' }
    }));
    expect(result.current.status).toBe('rejected: late');
    expect(result.current.serverTime(receivedAt)).toBeGreaterThanOrEqual(receivedAt + 4_900);
    expect(result.current.serverTime(receivedAt)).toBeLessThanOrEqual(receivedAt + 5_000);

    const state = {
      protocolVersion: '2.0', roomId: 'ROOM', matchId: null, revision: 1, phase: 'idle',
      config: { difficultySeconds: 8, challengeCount: 11, countdownSeconds: 3, scoreGraceMs: 1000, synchronizedGestures: false, captureSnapshots: true },
      players: {
        player1: { connected: false, clientId: null, score: 0, attempted: 0, finished: false, challenge: null },
        player2: { connected: false, clientId: null, score: 0, attempted: 0, finished: false, challenge: null }
      },
      countdownEndsAt: null, resolution: null, cinematic: null, winner: null, pendingWinner: null, updatedAt: receivedAt
    };
    const listener = vi.fn();
    const unsubscribe = result.current.subscribe(listener);
    act(() => messageListener({
      protocolVersion: '2.0', messageId: 'snapshot', messageType: 'room.snapshot',
      roomId: 'ROOM', matchId: null, revision: 1, sentAt: receivedAt + 1_000,
      payload: { state }
    }));
    expect(listener).toHaveBeenCalledOnce();
    expect(result.current.state?.revision).toBe(1);
    expect(result.current.serverTime(receivedAt)).toBeGreaterThanOrEqual(receivedAt + 4_900);
    unsubscribe();
    act(() => messageListener({
      protocolVersion: '2.0', messageId: 'ack', messageType: 'command.acknowledged',
      roomId: 'ROOM', matchId: null, revision: 1, sentAt: receivedAt + 1_000, payload: {}
    }));
    expect(listener).toHaveBeenCalledOnce();
    unmount();
    expect(close).toHaveBeenCalled();
  });

  it('does not create a transport after unmounting during config loading', async () => {
    vi.resetModules();
    let resolveConfig: (config: { webSocketUrl: string; apiBaseUrl: string }) => void = () => undefined;
    const config = new Promise<{ webSocketUrl: string; apiBaseUrl: string }>((resolve) => {
      resolveConfig = resolve;
    });
    const connect = vi.fn();
    vi.doMock('../services/config', () => ({ loadConfig: () => config }));
    vi.doMock('../services/controlTransport', () => ({
      WebSocketControlTransport: class {
        subscribe() { return vi.fn(); }
        subscribeStatus() { return vi.fn(); }
        connect = connect;
        close = vi.fn();
      }
    }));
    const { useGameSession } = await import('../services/useGameSession');
    const { unmount } = renderHook(() => useGameSession('ROOM', 'viewer'));
    unmount();
    resolveConfig({ webSocketUrl: 'wss://socket', apiBaseUrl: '' });
    await Promise.resolve();
    expect(connect).not.toHaveBeenCalled();
  });
});
