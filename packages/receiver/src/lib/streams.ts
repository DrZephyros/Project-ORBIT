import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage } from '@orbit/shared';

/**
 * One RTCPeerConnection per panel.
 *
 * Receivers are always the answerer: the desktop decides which capture source
 * feeds a panel, so it is the only side that needs to know about the source
 * being live. We keep per-panel connection state so a single failing decoder
 * never takes down the rest of the workspace.
 */

export type StreamStatus = 'idle' | 'connecting' | 'live' | 'failed';

export interface StreamSlot {
  status: StreamStatus;
  stream: MediaStream | null;
  /** Frames arriving, used for the "no video" diagnostic. */
  stats: { frames?: number; kbps?: number; width?: number; height?: number };
}

const ICE_SERVERS: RTCIceServer[] = [
  // LAN only: host candidates are enough. A STUN server is included so the
  // same receiver works over a VPN or hotspot without configuration.
  { urls: 'stun:stun.l.google.com:19302' },
];

export function useStreams(send: (msg: ClientMessage) => boolean) {
  const [streams, setStreams] = useState<Record<string, StreamSlot>>({});
  const pcs = useRef(new Map<string, RTCPeerConnection>());
  const statsTimers = useRef(new Map<string, number>());
  const sendRef = useRef(send);
  sendRef.current = send;

  const patch = useCallback((panelId: string, next: Partial<StreamSlot>) => {
    setStreams((prev) => {
      const cur = prev[panelId] ?? { status: 'idle' as StreamStatus, stream: null, stats: {} };
      return { ...prev, [panelId]: { ...cur, ...next } };
    });
  }, []);

  const cleanup = useCallback((panelId: string) => {
    const pc = pcs.current.get(panelId);
    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.close();
      pcs.current.delete(panelId);
    }
    const timer = statsTimers.current.get(panelId);
    if (timer) {
      window.clearInterval(timer);
      statsTimers.current.delete(panelId);
    }
  }, []);

  const closePanel = useCallback(
    (panelId: string) => {
      cleanup(panelId);
      setStreams((prev) => {
        const next = { ...prev };
        delete next[panelId];
        return next;
      });
    },
    [cleanup],
  );

  const handleOffer = useCallback(
    async (panelId: string, sdp: string) => {
      // Replace any previous connection for this panel (a re-broadcast).
      cleanup(panelId);

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, bundlePolicy: 'max-bundle' });
      pcs.current.set(panelId, pc);
      patch(panelId, { status: 'connecting', stream: null, stats: {} });

      pc.onicecandidate = (event) => {
        if (!event.candidate) return;
        sendRef.current({
          t: 'receiver.ice',
          panelId,
          candidate: {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
          },
        });
      };

      pc.ontrack = (event) => {
        const [incoming] = event.streams;
        const stream = incoming ?? new MediaStream([event.track]);
        patch(panelId, { stream, status: 'live' });
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (state === 'connected') patch(panelId, { status: 'live' });
        else if (state === 'failed') patch(panelId, { status: 'failed' });
        else if (state === 'disconnected') patch(panelId, { status: 'connecting' });
      };

      try {
        await pc.setRemoteDescription({ type: 'offer', sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendRef.current({ t: 'receiver.answer', panelId, req: { kind: 'answer', sdp: answer.sdp ?? '' } });
        startStats(panelId, pc);
      } catch {
        // Safari occasionally rejects a late offer after the panel closed.
        patch(panelId, { status: 'failed' });
      }
    },
    [cleanup, patch],
  );

  const addIce = useCallback(async (panelId: string, candidate: RTCIceCandidateInit) => {
    const pc = pcs.current.get(panelId);
    if (!pc) return;
    try {
      await pc.addIceCandidate(candidate);
    } catch {
      /* a candidate for a closed connection is expected on reconnect */
    }
  }, []);

  function startStats(panelId: string, pc: RTCPeerConnection): void {
    const timer = window.setInterval(async () => {
      try {
        const report = await pc.getStats();
        let frames: number | undefined;
        let bytes = 0;
        let width: number | undefined;
        let height: number | undefined;

        report.forEach((entry) => {
          if (entry.type === 'inbound-rtp' && (entry as RTCInboundRtpStreamStats).kind === 'video') {
            const rtp = entry as RTCInboundRtpStreamStats;
            frames = rtp.framesDecoded ?? frames;
            bytes = Number((rtp as unknown as { bytesReceived?: number }).bytesReceived ?? 0);
            width = rtp.frameWidth ?? width;
            height = rtp.frameHeight ?? height;
          }
        });

        // 2s window over the sample interval.
        patch(panelId, { stats: { frames, kbps: Math.round((bytes * 8) / 2000), width, height } });
      } catch {
        /* stats are diagnostic only */
      }
    }, 2000);
    statsTimers.current.set(panelId, timer);
  }

  useEffect(() => {
    return () => {
      for (const id of pcs.current.keys()) cleanup(id);
    };
  }, [cleanup]);

  return { streams, handleOffer, addIce, closePanel };
}
