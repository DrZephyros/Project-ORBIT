import { useCallback, useEffect, useRef } from 'react';
import { api, on } from '../env.js';

/**
 * Renderer-side WebRTC sender.
 *
 * Capture must happen here: Electron only allows getDisplayMedia in a frame,
 * and the main process authorises exactly one source id per call via
 * `grantCapture`. Each panel gets its own peer connection so a single stalled
 * receiver decoder cannot freeze the others.
 */

interface Sender {
  pc: RTCPeerConnection;
  stream: MediaStream;
  panelId: string;
}

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

export function useSenders(enabled: boolean) {
  const senders = useRef(new Map<string, Sender>());
  const pendingAnswers = useRef(new Map<string, { resolve: () => void }>());

  const stop = useCallback(async (panelId: string): Promise<void> => {
    const entry = senders.current.get(panelId);
    if (!entry) {
      void api().streamStop(panelId);
      return;
    }
    senders.current.delete(panelId);
    entry.pc.onicecandidate = null;
    entry.pc.onconnectionstatechange = null;
    try {
      entry.pc.close();
    } catch {
      /* already closed */
    }
    // Stop the capture immediately: a returned panel must not keep the source
    // window bound to a hidden capture session.
    entry.stream.getTracks().forEach((t) => t.stop());
    void api().streamStop(panelId);
  }, []);

  const stopRef = useRef(stop);
  stopRef.current = stop;

  const start = useCallback(
    async (panelId: string, sourceId: string): Promise<void> => {
      await stopRef.current(panelId);

      // 1. Authorise this exact window in the main process.
      const grant = await api().grantCapture(sourceId);
      if (!grant.ok) throw new Error(grant.reason ?? 'Capture was not authorised.');

      // 2. Capture it. `chromeMediaSource: 'desktop'` with a source id is the
      //    Electron-specific constraint that pins capture to one window.
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            // @ts-expect-error Electron-only constraints are not in lib.dom.
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId,
              maxWidth: 1920,
              maxHeight: 1200,
              maxFrameRate: 30,
            },
          },
        });
      } catch (error) {
        throw new Error(
          `Could not capture that window: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }

      const [track] = stream.getVideoTracks();
      if (!track) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error('The selected window produced no video track.');
      }

      // Sharing a window in Electron pauses its rendering for the local view;
      // we only need the encoded output, so stop the local preview track on the
      // capturing side but keep sending it to the receiver.
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      senders.current.set(panelId, { pc, stream, panelId });

      pc.addTrack(track, stream);

      pc.onicecandidate = (event) => {
        if (!event.candidate) return;
        void api().ice(panelId, {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        });
      };

      pc.onconnectionstatechange = () => {
        // A failed sender is reported, not silently retried (section 8).
        if (pc.connectionState === 'failed') {
          void stopRef.current(panelId);
        }
      };

      // 3. Offer. The answer arrives asynchronously over IPC.
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const answered = new Promise<void>((resolve) => {
        pendingAnswers.current.set(panelId, { resolve });
      });

      await api().offer(panelId, offer.sdp ?? '');

      // Do not block the UI forever on a receiver that never answers.
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 12_000));
      await Promise.race([answered, timeout]);
      pendingAnswers.current.delete(panelId);

      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        throw new Error('The receiver did not accept the stream.');
      }
    },
    [],
  );

  const stopAll = useCallback(async (): Promise<void> => {
    await Promise.all([...senders.current.keys()].map((id) => stopRef.current(id)));
  }, []);

  useEffect(() => {
    const offAnswer = on('orbit:ev-answer', (panelId: string, sdp: string) => {
      const entry = senders.current.get(panelId);
      if (!entry) return;
      void entry.pc
        .setRemoteDescription({ type: 'answer', sdp })
        .then(() => pendingAnswers.current.get(panelId)?.resolve())
        .catch(() => undefined);
    });

    const offIce = on('orbit:ev-ice-remote', (panelId: string, candidate: unknown) => {
      const entry = senders.current.get(panelId);
      if (!entry) return;
      void entry.pc.addIceCandidate(candidate as RTCIceCandidateInit).catch(() => undefined);
    });

    return () => {
      offAnswer();
      offIce();
    };
  }, []);

  useEffect(() => {
    if (!enabled) void stopAll();
  }, [enabled, stopAll]);

  useEffect(() => {
    return () => {
      for (const entry of senders.current.values()) {
        entry.stream.getTracks().forEach((t) => t.stop());
        entry.pc.close();
      }
      senders.current.clear();
    };
  }, []);

  return { start, stop, stopAll };
}
