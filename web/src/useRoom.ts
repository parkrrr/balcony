import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { ChatMessage, Peer } from "./types";

export type RoomStatus = "connecting" | "connected" | "disconnected" | "unauthorized";

interface Playback {
  t: number;
  playing: boolean;
  rate: number;
}

const HEARTBEAT_MS = 5_000;
const PEER_STALE_MS = 15_000;
const MAX_MESSAGES = 500;

/**
 * One Socket.IO connection per video. Chat goes through the server; positions are
 * relayed to the room and each client keeps its own view of who is where.
 */
export function useRoom(videoId: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [peers, setPeers] = useState<Map<string, Peer>>(() => new Map());
  const [status, setStatus] = useState<RoomStatus>("connecting");
  const socketRef = useRef<Socket | null>(null);
  const latest = useRef<Playback | null>(null);
  const lastSent = useRef<(Playback & { at: number }) | null>(null);

  const sendPosition = useCallback((force: boolean) => {
    const socket = socketRef.current;
    const cur = latest.current;
    if (!socket?.connected || !cur) return;
    const now = Date.now();
    const last = lastSent.current;
    if (!force && last) {
      // Others extrapolate from our last report, so only resend when that guess goes wrong
      // (seek, pause/play, rate change) or as a heartbeat.
      const expected = last.playing ? last.t + ((now - last.at) / 1000) * last.rate : last.t;
      const unchanged = cur.playing === last.playing && cur.rate === last.rate && Math.abs(cur.t - expected) < 1.5;
      if (unchanged && now - last.at < HEARTBEAT_MS) return;
    }
    socket.volatile.emit("position", cur);
    lastSent.current = { ...cur, at: now };
  }, []);

  useEffect(() => {
    const socket = io({ transports: ["websocket"], query: { v: videoId } });
    socketRef.current = socket;
    setStatus("connecting");

    socket.on("connect", () => {
      setStatus("connected");
      sendPosition(true);
    });
    socket.on("disconnect", () => setStatus("disconnected"));
    socket.on("connect_error", (err) => setStatus(err.message === "unauthorized" ? "unauthorized" : "disconnected"));
    socket.on("history", (history: ChatMessage[]) => setMessages(history));
    socket.on("chat", (m: ChatMessage) => setMessages((prev) => [...prev, m].slice(-MAX_MESSAGES)));
    socket.on("who", () => sendPosition(true));
    socket.on("position", (p: Omit<Peer, "at">) => setPeers((prev) => new Map(prev).set(p.id, { ...p, at: Date.now() })));
    socket.on("left", ({ id }: { id: string }) =>
      setPeers((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      }),
    );

    const sweep = setInterval(() => {
      const cutoff = Date.now() - PEER_STALE_MS;
      setPeers((prev) => {
        const stale = [...prev.values()].filter((p) => p.at < cutoff);
        if (!stale.length) return prev;
        const next = new Map(prev);
        stale.forEach((p) => next.delete(p.id));
        return next;
      });
    }, PEER_STALE_MS / 3);

    return () => {
      clearInterval(sweep);
      socket.disconnect();
      socketRef.current = null;
      lastSent.current = null;
      setMessages([]);
      setPeers(new Map());
    };
  }, [videoId, sendPosition]);

  const report = useCallback(
    (playback: Playback) => {
      latest.current = playback;
      sendPosition(false);
    },
    [sendPosition],
  );

  const send = useCallback(async (text: string, videoTime: number | null): Promise<string | null> => {
    const socket = socketRef.current;
    if (!socket?.connected) return "Not connected.";
    try {
      const res: { ok: true } | { error: string } = await socket.timeout(10_000).emitWithAck("chat", { text, videoTime });
      return "error" in res ? res.error : null;
    } catch {
      return "Couldn't send that message. Try again.";
    }
  }, []);

  return { messages, peers, status, report, send };
}
