import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, describe, test } from "node:test";
import { createAppServer } from "../src/app.js";
import type { Config } from "../src/config.js";
import { SESSION_COOKIE, signSession } from "../src/session.js";
import { MemoryReactionStore, MemoryStore } from "../src/store.js";

const config: Config = {
  port: 0,
  baseUrl: null,
  google: null,
  sessionSecret: "x".repeat(32),
  secureCookies: false,
  cosmos: null,
  webDist: "does-not-exist",
};

const closers: (() => void)[] = [];
after(() => closers.forEach((close) => close()));

async function start(reactions: MemoryReactionStore) {
  const { server, io } = createAppServer(config, new MemoryStore(), reactions, async () => null);
  closers.push(() => io.close());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return `http://localhost:${(server.address() as AddressInfo).port}/api/random-video`;
}

const signedIn = async () => ({
  cookie: `${SESSION_COOKIE}=${await signSession({ id: "guest:x", name: "X", avatar: null, channelId: null }, config.sessionSecret)}`,
});

let n = 0;
async function throwAt(store: MemoryReactionStore, videoId: string, times: number) {
  for (let i = 0; i < times; i++) {
    await store.add({ id: `r${n++}`, videoId, emoji: "🍅", videoTime: 1, createdAt: Date.now() }, "u");
  }
}

describe("random video", () => {
  test("says so when nobody has reacted yet, and needs a session", async () => {
    const url = await start(new MemoryReactionStore());
    assert.equal((await fetch(url)).status, 401);
    const res = await fetch(url, { headers: await signedIn() });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Nobody has reacted to a video yet." });
  });

  test("picks every reacted video equally often, whatever its reaction count", async () => {
    const store = new MemoryReactionStore();
    await throwAt(store, "busy0000000", 500);
    await throwAt(store, "quiet000000", 1);
    const url = await start(store);
    const headers = await signedIn();

    const picks = new Map<string, number>();
    for (let i = 0; i < 300; i++) {
      const { videoId } = (await (await fetch(url, { headers })).json()) as { videoId: string };
      picks.set(videoId, (picks.get(videoId) ?? 0) + 1);
    }
    assert.deepEqual([...picks.keys()].sort(), ["busy0000000", "quiet000000"]);
    // Uniform means ~150 each. Weighting by reactions would give the quiet video ~1 pick in 300.
    // The bounds are 6 standard deviations out, so this won't flake.
    const quiet = picks.get("quiet000000")!;
    assert.ok(quiet > 98 && quiet < 202, `quiet video picked ${quiet} times out of 300`);
  });

  test("never picks the video being watched", async () => {
    const store = new MemoryReactionStore();
    await throwAt(store, "watching000", 1);
    await throwAt(store, "other000000", 1);
    const url = await start(store);
    const headers = await signedIn();

    for (let i = 0; i < 20; i++) {
      assert.deepEqual(await (await fetch(`${url}?exclude=watching000`, { headers })).json(), { videoId: "other000000" });
    }
    const alone = await fetch(`${url}?exclude=other000000&exclude=x`, { headers });
    assert.equal(alone.status, 200, "a repeated exclude parameter is ignored rather than crashing");

    const onlyThis = new MemoryReactionStore();
    await throwAt(onlyThis, "watching000", 1);
    const res = await fetch(`${await start(onlyThis)}?exclude=watching000`, { headers });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "No other videos have reactions yet." });
  });
});
