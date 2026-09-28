import type { Role, WebRtcPayload, WebRtcSignalType } from '../core/protocol';

export class WebRtcSessionService {
  private peers = new Map<string, RTCPeerConnection>();
  private pendingCandidates = new Map<string, RTCIceCandidateInit[]>();
  constructor(
    private readonly role: Role,
    private readonly sendSignal: (signalType: WebRtcSignalType, payload: WebRtcPayload, to?: string) => void,
    private readonly onStream: (role: Role, stream: MediaStream) => void
  ) {}

  private peer(id: string, remoteRole: Role) {
    let pc = this.peers.get(id);
    if (pc) return pc;
    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    pc.onicecandidate = ({ candidate }) => this.sendSignal('iceCandidate', {
      candidate: candidate?.candidate ?? null,
      sdpMid: candidate?.sdpMid ?? null,
      sdpMLineIndex: candidate?.sdpMLineIndex ?? null
    }, id);
    pc.ontrack = ({ streams }) => streams[0] && this.onStream(remoteRole, streams[0]);
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc!.connectionState)) {
        pc!.close();
        this.peers.delete(id);
        this.pendingCandidates.delete(id);
      }
    };
    this.peers.set(id, pc);
    return pc;
  }

  private async flushCandidates(id: string, peer: RTCPeerConnection) {
    const candidates = this.pendingCandidates.get(id) ?? [];
    this.pendingCandidates.delete(id);
    for (const candidate of candidates) {
      await peer.addIceCandidate(candidate);
    }
  }

  playerReady() { this.sendSignal('playerReady', {}); }
  viewerRequested(to?: string) { this.sendSignal('viewerRequested', {}, to); }
  async handle(signalType: WebRtcSignalType, payload: WebRtcPayload, from: string, remoteRole: Role, localStream?: MediaStream) {
    if (signalType === 'playerReady' && this.role === 'viewer') {
      this.viewerRequested(from);
      return;
    }
    const pc = this.peer(from, remoteRole);
    if (signalType === 'viewerRequested' && this.role !== 'viewer' && localStream) {
      localStream.getTracks().forEach((track) => {
        if (!pc!.getSenders().some((sender) => sender.track === track)) pc!.addTrack(track, localStream);
      });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.sendSignal('offer', { sdp: offer.sdp ?? '' }, from);
    } else if (signalType === 'offer' && this.role === 'viewer' && payload.sdp) {
      await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
      await this.flushCandidates(from, pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.sendSignal('answer', { sdp: answer.sdp ?? '' }, from);
    } else if (signalType === 'answer' && payload.sdp) {
      if (pc.signalingState !== 'have-local-offer') return;
      await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
      await this.flushCandidates(from, pc);
    } else if (signalType === 'iceCandidate' && payload.candidate) {
      const candidate = {
        candidate: payload.candidate,
        sdpMid: payload.sdpMid ?? undefined,
        sdpMLineIndex: payload.sdpMLineIndex ?? undefined
      };
      if (!pc.remoteDescription) {
        const pending = this.pendingCandidates.get(from) ?? [];
        pending.push(candidate);
        this.pendingCandidates.set(from, pending);
      } else {
        await pc.addIceCandidate(candidate);
      }
    } else if (signalType === 'peerClosed') {
      pc.close();
      this.peers.delete(from);
      this.pendingCandidates.delete(from);
    }
  }
  close() {
    this.sendSignal('peerClosed', {});
    this.peers.forEach((peer) => peer.close());
    this.peers.clear();
    this.pendingCandidates.clear();
  }
}
