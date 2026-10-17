import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { io as connect, type Socket } from "socket.io-client";
import { createAppServer } from "../src/app.js";
import { safeReturnTo } from "../src/auth.js";
import type { PositionEvent } from "../src/chat.js";
import type { Config } from "../src/config.js";
import { SESSION_COOKIE, readSession, signSession, type User } from "../src/session.js";
import { MemoryStore, type ChatMessage } from "../src/store.js";

const config: Config = {
  port: 0,
  baseUrl: null,
  googleClientId: "test",
  googleClientSecret: "test",
  sessionSecret: "x".repeat(32),
  secureCookies: false,
  cosmos: null,
  webDist: "does-not-exist",
};

const VIDEO = "dQw4w9WgXcQ";
const alice: User = { id: "alice", name: "Alice", avatar: null, channelId: "UCalice" };
const bob: User = { id: "bob", name: "Bob", avatar: "https://example.com/bob.png", channelId: null };

let url: string;
const { server, io } = createAppServer(config, new MemoryStore());
const sockets: Socket[] = [];

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  url = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  sockets.forEach((s) => s.disconnect());
  io.close();
});

async function join(user: User | null, videoId = VIDEO, origin = url) {
  const headers: Record<string, string> = { origin };
  if (user) headers.cookie = `${SESSION_COOKIE}=${await signSession(user, config.sessionSecret)}`;
  const socket = connect(url, { transports: ["websocket"], query: { v: videoId }, extraHeaders: headers, forceNew: true });
  sockets.push(socket);
  return socket;
}

function next<T>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, resolve));
}

function connectError(socket: Socket): Promise<Error> {
  return new Promise((resolve) => socket.once("connect_error", resolve));
}

describe("session", () => {
  test("round-trips through the cookie", async () => {
    const token = await signSession(alice, config.sessionSecret);
    assert.deepEqual(await readSession(`other=1; ${SESSION_COOKIE}=${token}`, config.sessionSecret), alice);
  });

  test("rejects a token signed with another secret", async () => {
    const token = await signSession(alice, "y".repeat(32));
    assert.equal(await readSession(`${SESSION_COOKIE}=${token}`, config.sessionSecret), null);
  });

  test("returnTo only allows same-site paths", () => {
    assert.equal(safeReturnTo("/watch?v=abc"), "/watch?v=abc");
    assert.equal(safeReturnTo("//evil.example"), "/");
    assert.equal(safeReturnTo("/\\evil.example"), "/");
    assert.equal(safeReturnTo("https://evil.example"), "/");
    assert.equal(safeReturnTo(undefined), "/");
  });
});

describe("chat socket", () => {
  test("rejects connections without a session", async () => {
    const err = await connectError(await join(null));
    assert.equal(err.message, "unauthorized");
  });

  test("rejects an invalid video id", async () => {
    const err = await connectError(await join(alice, "bad id!"));
    assert.equal(err.message, "invalid video");
  });

  test("rejects cross-origin handshakes", async () => {
    await connectError(await join(alice, VIDEO, "https://evil.example"));
  });

  test("delivers chat, history, positions and departures within a room", async () => {
    const a = await join(alice);
    assert.deepEqual(await next<ChatMessage[]>(a, "history"), []);

    const ack = await a.emitWithAck("chat", { text: "  hello  ", videoTime: 12.5 });
    assert.deepEqual(ack, { ok: true });

    // A later joiner gets the history, and the existing viewer is asked to report in.
    const who = next(a, "who");
    const b = await join(bob);
    const history = await next<ChatMessage[]>(b, "history");
    assert.equal(history.length, 1);
    assert.equal(history[0].text, "hello");
    assert.equal(history[0].videoTime, 12.5);
    assert.equal(history[0].name, "Alice");
    await who;

    const live = next<ChatMessage>(a, "chat");
    await b.emitWithAck("chat", { text: "hi alice" });
    assert.equal((await live).name, "Bob");

    const pos = next<PositionEvent>(b, "position");
    a.emit("position", { t: 42, playing: true, rate: 1.5 });
    assert.deepEqual(await pos, { id: a.id, user: { id: "alice", name: "Alice", avatar: null }, t: 42, playing: true, rate: 1.5 });

    // Other rooms see none of it.
    const c = await join(bob, "aaaaaaaaaaa");
    assert.deepEqual(await next<ChatMessage[]>(c, "history"), []);

    const left = next<{ id: string }>(b, "left");
    const aliceId = a.id;
    a.disconnect();
    assert.equal((await left).id, aliceId);
  });

  test("validates and rate-limits messages", async () => {
    const s = await join(alice, "bbbbbbbbbbb");
    await next(s, "history");
    assert.ok("error" in (await s.emitWithAck("chat", { text: "   " })));
    assert.ok("error" in (await s.emitWithAck("chat", { text: "x".repeat(501) })));
    for (let i = 0; i < 5; i++) assert.deepEqual(await s.emitWithAck("chat", { text: `m${i}` }), { ok: true });
    assert.deepEqual(await s.emitWithAck("chat", { text: "one too many" }), { error: "Slow down a little." });
  });
});
