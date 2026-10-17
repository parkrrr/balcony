import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { io as connect, type Socket } from "socket.io-client";
import { createAppServer } from "../src/app.js";
import { cleanName, safeReturnTo } from "../src/auth.js";
import { REACTION_QUOTA, isEmoji, type PositionEvent, type PublicReaction } from "../src/chat.js";
import type { Config } from "../src/config.js";
import { SESSION_COOKIE, readSession, signSession, type User } from "../src/session.js";
import { MemoryReactionStore, MemoryStore, type ChatMessage } from "../src/store.js";

const config: Config = {
  port: 0,
  baseUrl: null,
  google: null,
  sessionSecret: "x".repeat(32),
  secureCookies: false,
  cosmos: null,
  webDist: "does-not-exist",
};

const VIDEO = "dQw4w9WgXcQ";
const alice: User = { id: "alice", name: "Alice", avatar: null, channelId: "UCalice" };
const bob: User = { id: "bob", name: "Bob", avatar: "https://example.com/bob.png", channelId: null };

let url: string;
const reactionStore = new MemoryReactionStore();
const { server, io } = createAppServer(config, new MemoryStore(), reactionStore);
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

describe("reactions", () => {
  test("accepts exactly one emoji", () => {
    for (const ok of ["🍅", "❤️", "👍🏽", "👨‍👩‍👧‍👦", "🇯🇵", "🏳️‍🌈", "1️⃣", "#️⃣"]) assert.ok(isEmoji(ok), ok);
    for (const bad of ["", "a", "1", "#", "🍅🍅", "🍅 ", "hi🍅", "🇯", "1️⃣1️⃣", 42, null]) assert.ok(!isEmoji(bad), String(bad));
  });

  test("relays reactions anonymously and replays them to later joiners", async () => {
    const room = "ccccccccccc";
    const a = await join(alice, room);
    assert.deepEqual(await next<PublicReaction[]>(a, "reactions"), []);

    const b = await join(bob, room);
    await next(b, "reactions");
    const live = next<PublicReaction>(b, "reaction");
    const ack = await a.emitWithAck("react", { emoji: "🍅", videoTime: 61.5 });
    // No remaining-quota count: the limit is enforced quietly.
    assert.deepEqual(Object.keys(ack).sort(), ["ok", "reaction"]);
    assert.deepEqual(await live, ack.reaction);
    assert.deepEqual(Object.keys(ack.reaction).sort(), ["emoji", "id", "videoTime"]);

    const c = await join(alice, room);
    assert.deepEqual(await next<PublicReaction[]>(c, "reactions"), [{ id: ack.reaction.id, emoji: "🍅", videoTime: 61.5 }]);
  });

  test("validates, rate-limits and caps reactions", async () => {
    const room = "ddddddddddd";
    const s = await join(alice, room);
    await next(s, "reactions");
    assert.ok("error" in (await s.emitWithAck("react", { emoji: "lol", videoTime: 1 })));
    assert.ok("error" in (await s.emitWithAck("react", { emoji: "🍅" })));
    assert.equal((await s.emitWithAck("react", { emoji: "🍅", videoTime: 1 })).ok, true);
    assert.deepEqual(await s.emitWithAck("react", { emoji: "🥚", videoTime: 2 }), { error: "One reaction a second, please." });

    // Fill the rest of the quota directly rather than waiting out the rate limit 49 times.
    for (let i = 1; i < REACTION_QUOTA; i++) {
      await reactionStore.add({ id: `seed${i}`, videoId: room, userId: "alice", emoji: "🥚", videoTime: i, createdAt: 0 });
    }
    const fresh = await join(alice, room);
    await next(fresh, "reactions");
    assert.deepEqual(await fresh.emitWithAck("react", { emoji: "🍅", videoTime: 3 }), {
      error: "You've reached the reaction limit for this video.",
    });
  });
});

describe("guest sign-in", () => {
  const guest = (body: unknown, origin = url) =>
    fetch(`${url}/auth/guest`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });

  test("tidies names and rejects unusable ones", () => {
    assert.equal(cleanName("  Velvet   Owl "), "Velvet Owl");
    assert.equal(cleanName("Bob‮evil"), "Bobevil");
    assert.equal(cleanName("Tab\tand\nnewline"), "Tab and newline");
    assert.equal(cleanName("👨‍👩‍👧 fan"), "👨‍👩‍👧 fan");
    for (const bad of ["", "   ", "\u0007", "x".repeat(33), 42, null]) assert.equal(cleanName(bad), null, String(bad));
  });

  test("signs in with a chosen name and a fresh guest identity", async () => {
    const res = await guest({ name: " Velvet Owl " });
    assert.equal(res.status, 200);
    const user = (await res.json()) as User;
    assert.equal(user.name, "Velvet Owl");
    assert.match(user.id, /^guest:[0-9a-f-]{36}$/);

    const cookie = res.headers.get("set-cookie")!.split(";")[0];
    const me = await fetch(`${url}/api/me`, { headers: { cookie } });
    assert.deepEqual(await me.json(), user);

    // Same name again is a different person.
    const again = (await (await guest({ name: "Velvet Owl" })).json()) as User;
    assert.notEqual(again.id, user.id);
  });

  test("rejects bad names and cross-site requests", async () => {
    assert.equal((await guest({ name: "   " })).status, 400);
    assert.equal((await guest({})).status, 400);
    assert.equal((await guest({ name: "Velvet Owl" }, "https://evil.example")).status, 403);
  });

  test("keeps Google sign-in off unless configured", async () => {
    assert.deepEqual(await (await fetch(`${url}/api/me`)).json(), { error: "unauthorized", google: false });
    const login = await fetch(`${url}/auth/login`, { redirect: "manual" });
    assert.notEqual(login.status, 302);
  });
});
