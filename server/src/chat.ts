import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Server, Socket } from "socket.io";
import type { Config } from "./config.js";
import { readSession, type User } from "./session.js";
import type { ChatMessage, MessageStore } from "./store.js";

export const HISTORY_LIMIT = 100;
export const MAX_MESSAGE_LENGTH = 500;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_MESSAGES = 5;
const POSITION_MIN_INTERVAL_MS = 500;
const MAX_VIDEO_SECONDS = 7 * 24 * 60 * 60;

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
export const isVideoId = (v: unknown): v is string => typeof v === "string" && VIDEO_ID.test(v);

export interface PublicUser {
  id: string;
  name: string;
  avatar: string | null;
}

/** Broadcast to the rest of the room whenever a viewer's playback changes (and as a heartbeat). */
export interface PositionEvent {
  id: string;
  user: PublicUser;
  t: number;
  playing: boolean;
  rate: number;
}

type ChatAck = (res: { ok: true } | { error: string }) => void;

interface SocketData {
  user: User;
  videoId: string;
}

const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_VIDEO_SECONDS;

/** Rejects cross-site WebSocket handshakes; the session cookie alone would otherwise authorize them. */
export function sameOrigin(config: Config, req: IncomingMessage): boolean {
  const originHeader = req.headers.origin;
  if (!originHeader) return false;
  if (config.baseUrl) return originHeader === config.baseUrl;
  try {
    const forwarded = req.headers["x-forwarded-host"];
    const host = (Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? req.headers.host;
    return new URL(originHeader).host === host;
  } catch {
    return false;
  }
}

export function attachChat(io: Server, config: Config, store: MessageStore): void {
  io.use(async (socket, next) => {
    const user = await readSession(socket.handshake.headers.cookie, config.sessionSecret);
    if (!user) return next(new Error("unauthorized"));
    const videoId = socket.handshake.query.v;
    if (!isVideoId(videoId)) return next(new Error("invalid video"));
    socket.data = { user, videoId } satisfies SocketData;
    next();
  });

  io.on("connection", (socket: Socket) => {
    const { user, videoId } = socket.data as SocketData;
    const room = `video:${videoId}`;
    const publicUser: PublicUser = { id: user.id, name: user.name, avatar: user.avatar };
    const sentAt: number[] = [];
    let lastPositionAt = 0;

    socket.join(room);
    // Ask everyone already here to report their position now rather than on their next heartbeat.
    socket.to(room).emit("who");

    store.recent(videoId, HISTORY_LIMIT).then(
      (messages) => socket.emit("history", messages),
      (err) => {
        console.error("Loading history failed", err);
        socket.emit("history", []);
      },
    );

    socket.on("chat", async (payload: unknown, ack?: ChatAck) => {
      const reply: ChatAck = typeof ack === "function" ? ack : () => {};
      const p = (payload ?? {}) as { text?: unknown; videoTime?: unknown };
      const text = typeof p.text === "string" ? p.text.trim() : "";
      if (!text || text.length > MAX_MESSAGE_LENGTH) return reply({ error: "Message must be 1–500 characters." });

      const now = Date.now();
      while (sentAt.length && now - sentAt[0] > RATE_WINDOW_MS) sentAt.shift();
      if (sentAt.length >= RATE_MAX_MESSAGES) return reply({ error: "Slow down a little." });
      sentAt.push(now);

      const message: ChatMessage = {
        id: randomUUID(),
        videoId,
        userId: user.id,
        name: user.name,
        avatar: user.avatar,
        text,
        videoTime: isTime(p.videoTime) ? p.videoTime : null,
        createdAt: now,
      };
      try {
        await store.add(message);
      } catch (err) {
        console.error("Saving message failed", err);
        return reply({ error: "Couldn't send that message. Try again." });
      }
      io.to(room).emit("chat", message);
      reply({ ok: true });
    });

    socket.on("position", (payload: unknown) => {
      const p = (payload ?? {}) as { t?: unknown; playing?: unknown; rate?: unknown };
      if (!isTime(p.t)) return;
      const now = Date.now();
      if (now - lastPositionAt < POSITION_MIN_INTERVAL_MS) return;
      lastPositionAt = now;

      const rate = typeof p.rate === "number" && p.rate > 0 && p.rate <= 4 ? p.rate : 1;
      const event: PositionEvent = { id: socket.id, user: publicUser, t: p.t, playing: p.playing === true, rate };
      socket.to(room).volatile.emit("position", event);
    });

    socket.on("disconnect", () => {
      socket.to(room).emit("left", { id: socket.id });
    });
  });
}
