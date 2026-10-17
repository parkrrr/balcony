import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { createAppServer } from "../src/app.js";
import type { Config } from "../src/config.js";
import { MOST_REACTED_WINDOW_MS, rankMostReacted, type MostReacted } from "../src/mostReacted.js";
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

const reactions = new MemoryReactionStore();
const lookups: string[] = [];
const { server, io } = createAppServer(config, new MemoryStore(), reactions, async (videoId) => {
  lookups.push(videoId);
  return videoId === "gone0000000" ? null : { title: `Title of ${videoId}`, channel: "Some Channel" };
});
let url: string;

let n = 0;
async function throwAt(videoId: string, emoji: string, times: number, createdAt = Date.now()) {
  for (let i = 0; i < times; i++) {
    await reactions.add({ id: `r${n++}`, videoId, emoji, videoTime: 1, createdAt }, "u");
  }
}

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  url = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(() => {
  io.close();
});

describe("most reacted", () => {
  test("ranks by total and keeps each video's top three emoji", () => {
    const ranked = rankMostReacted([
      { videoId: "b", emoji: "😂", count: 4 },
      { videoId: "a", emoji: "👏", count: 2 },
      { videoId: "a", emoji: "😂", count: 2 },
      { videoId: "a", emoji: "🍅", count: 1 },
      { videoId: "a", emoji: "❤️", count: 1 },
      { videoId: "c", emoji: "🔥", count: 1 },
    ]);
    assert.deepEqual(
      ranked.map((v) => [v.videoId, v.total]),
      [
        ["a", 6],
        ["b", 4],
        ["c", 1],
      ],
    );
    // Equal counts go in code point order, so every server agrees.
    assert.deepEqual(ranked[0].top, [
      { emoji: "👏", count: 2 },
      { emoji: "😂", count: 2 },
      { emoji: "❤️", count: 1 },
    ]);
  });

  test("serves the week's top five with titles, to signed-in viewers only", async () => {
    await throwAt("aaaaaaaaaaa", "😂", 9);
    await throwAt("aaaaaaaaaaa", "👏", 3);
    await throwAt("bbbbbbbbbbb", "🍅", 7);
    await throwAt("gone0000000", "❤️", 6);
    for (const id of ["ccccccccccc", "ddddddddddd", "eeeeeeeeeee"]) await throwAt(id, "🔥", 2);
    // Busier than anything, but thrown more than a week ago.
    await throwAt("old00000000", "💩", 50, Date.now() - MOST_REACTED_WINDOW_MS - 60_000);

    assert.equal((await fetch(`${url}/api/most-reacted`)).status, 401);

    const cookie = `${SESSION_COOKIE}=${await signSession({ id: "guest:x", name: "X", avatar: null, channelId: null }, config.sessionSecret)}`;
    const list = (await (await fetch(`${url}/api/most-reacted`, { headers: { cookie } })).json()) as MostReacted[];

    assert.deepEqual(
      list.map((v) => v.videoId),
      ["aaaaaaaaaaa", "bbbbbbbbbbb", "gone0000000", "ccccccccccc", "ddddddddddd"],
    );
    assert.deepEqual(list[0], {
      videoId: "aaaaaaaaaaa",
      title: "Title of aaaaaaaaaaa",
      channel: "Some Channel",
      total: 12,
      top: [
        { emoji: "😂", count: 9 },
        { emoji: "👏", count: 3 },
      ],
    });
    // A video YouTube can't describe still makes the list, just without a title.
    assert.equal(list[2].title, null);

    // A second visitor within the cache window gets the same result without new lookups.
    const before = lookups.length;
    await fetch(`${url}/api/most-reacted`, { headers: { cookie } });
    assert.equal(lookups.length, before);
  });
});
