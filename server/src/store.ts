import { createHash } from "node:crypto";
import { CosmosClient, type Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

export interface ChatMessage {
  id: string;
  videoId: string;
  userId: string;
  name: string;
  avatar: string | null;
  text: string;
  /** Sender's playback position in seconds when they sent it. */
  videoTime: number | null;
  createdAt: number;
}

export interface MessageStore {
  add(message: ChatMessage): Promise<void>;
  /** Newest `limit` messages for a video, oldest first. */
  recent(videoId: string, limit: number): Promise<ChatMessage[]>;
}

/**
 * Chat messages are deleted 30 days after they're sent. In Cosmos this is the messages
 * container's default_ttl (infra/main.tf); the memory store applies it itself.
 */
export const MESSAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class MemoryStore implements MessageStore {
  private readonly byVideo = new Map<string, ChatMessage[]>();

  constructor(
    private readonly keep = 500,
    private readonly now = () => Date.now(),
  ) {}

  async add(message: ChatMessage): Promise<void> {
    const list = this.live(message.videoId);
    list.push(message);
    if (list.length > this.keep) list.splice(0, list.length - this.keep);
    this.byVideo.set(message.videoId, list);
  }

  async recent(videoId: string, limit: number): Promise<ChatMessage[]> {
    return this.live(videoId).slice(-limit);
  }

  /** A room's messages with anything past retention dropped for good. */
  private live(videoId: string): ChatMessage[] {
    const list = this.byVideo.get(videoId);
    if (!list) return [];
    const cutoff = this.now() - MESSAGE_RETENTION_MS;
    const kept = list.filter((m) => m.createdAt >= cutoff);
    if (kept.length !== list.length) this.byVideo.set(videoId, kept);
    return kept;
  }
}

/** Container is partitioned on /videoId, so each room's history is a single-partition query. */
export class CosmosStore implements MessageStore {
  private readonly container: Container;

  constructor(endpoint: string, database: string, container: string) {
    const client = new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });
    this.container = client.database(database).container(container);
  }

  async add(message: ChatMessage): Promise<void> {
    await this.container.items.create(message);
  }

  async recent(videoId: string, limit: number): Promise<ChatMessage[]> {
    const { resources } = await this.container.items
      .query<ChatMessage>(
        {
          query:
            "SELECT TOP @limit c.id, c.videoId, c.userId, c.name, c.avatar, c.text, c.videoTime, c.createdAt " +
            "FROM c WHERE c.videoId = @videoId ORDER BY c.createdAt DESC",
          parameters: [
            { name: "@limit", value: limit },
            { name: "@videoId", value: videoId },
          ],
        },
        { partitionKey: videoId },
      )
      .fetchAll();
    return resources.reverse();
  }
}

/**
 * Fully anonymous: nothing in a reaction says who threw it, so reactions can be kept for good
 * and keep replaying. The per-person limit is tracked separately, in counters that expire.
 */
export interface Reaction {
  id: string;
  videoId: string;
  emoji: string;
  /** Thrower's playback position in seconds; the reaction replays when anyone's playhead reaches it. */
  videoTime: number;
  createdAt: number;
}

/**
 * A viewer's quota counter on a video expires this long after their last reaction on it.
 * In Cosmos this is the reaction-quotas container's default_ttl (infra/main.tf).
 */
export const QUOTA_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Counters are keyed by a hash, so the raw user ID isn't stored even in them. */
const quotaKey = (userId: string) => createHash("sha256").update(userId).digest("hex");

export interface ReactionStore {
  /** Saves the reaction and counts it against `thrownBy`'s quota for that video. */
  add(reaction: Reaction, thrownBy: string): Promise<void>;
  /** Every reaction on a video, in no particular order. */
  forVideo(videoId: string): Promise<Reaction[]>;
  /** How many reactions this viewer has thrown at this video, until their counter expires. */
  quotaUsed(videoId: string, userId: string): Promise<number>;
  /** How many of each emoji every video got from reactions thrown at or after `since` (ms). */
  countsSince(since: number): Promise<EmojiCount[]>;
  /** Every video with at least one reaction, each once. */
  reactedVideoIds(): Promise<string[]>;
}

export interface EmojiCount {
  videoId: string;
  emoji: string;
  count: number;
}

export class MemoryReactionStore implements ReactionStore {
  private readonly byVideo = new Map<string, Reaction[]>();
  private readonly quotas = new Map<string, { count: number; at: number }>();

  constructor(private readonly now = () => Date.now()) {}

  async add(reaction: Reaction, thrownBy: string): Promise<void> {
    const list = this.byVideo.get(reaction.videoId) ?? [];
    list.push(reaction);
    this.byVideo.set(reaction.videoId, list);
    const key = `${reaction.videoId} ${quotaKey(thrownBy)}`;
    this.quotas.set(key, { count: (await this.quotaUsed(reaction.videoId, thrownBy)) + 1, at: this.now() });
  }

  async forVideo(videoId: string): Promise<Reaction[]> {
    return [...(this.byVideo.get(videoId) ?? [])];
  }

  async quotaUsed(videoId: string, userId: string): Promise<number> {
    const key = `${videoId} ${quotaKey(userId)}`;
    const quota = this.quotas.get(key);
    if (!quota) return 0;
    if (this.now() - quota.at < QUOTA_RETENTION_MS) return quota.count;
    this.quotas.delete(key);
    return 0;
  }

  async reactedVideoIds(): Promise<string[]> {
    return [...this.byVideo].filter(([, list]) => list.length > 0).map(([videoId]) => videoId);
  }

  async countsSince(since: number): Promise<EmojiCount[]> {
    const counts = new Map<string, EmojiCount>();
    for (const list of this.byVideo.values()) {
      for (const r of list) {
        if (r.createdAt < since) continue;
        const key = `${r.videoId} ${r.emoji}`;
        const entry = counts.get(key) ?? { videoId: r.videoId, emoji: r.emoji, count: 0 };
        entry.count++;
        counts.set(key, entry);
      }
    }
    return [...counts.values()];
  }
}

interface QuotaDoc {
  id: string;
  videoId: string;
  count: number;
}

const statusOf = (err: unknown) => (err as { code?: number }).code;

/**
 * Reactions and quota counters live in separate containers, both partitioned on /videoId.
 * Reactions are kept for good; counters expire via the quotas container's default_ttl, which
 * Cosmos counts from each counter's last write, i.e. the viewer's last reaction on that video.
 */
export class CosmosReactionStore implements ReactionStore {
  private readonly container: Container;
  private readonly quotas: Container;

  constructor(endpoint: string, database: string, container: string, quotasContainer: string) {
    const client = new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });
    this.container = client.database(database).container(container);
    this.quotas = client.database(database).container(quotasContainer);
  }

  async add(reaction: Reaction, thrownBy: string): Promise<void> {
    await this.container.items.create(reaction);
    await this.countThrow(reaction.videoId, quotaKey(thrownBy));
  }

  /** Atomic increment; the first reaction on a video creates the counter instead. */
  private async countThrow(videoId: string, id: string): Promise<void> {
    const increment = () => this.quotas.item(id, videoId).patch([{ op: "incr", path: "/count", value: 1 }]);
    try {
      await increment();
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
      try {
        await this.quotas.items.create<QuotaDoc>({ id, videoId, count: 1 });
      } catch (createErr) {
        // Another tab created it first; count this one on top.
        if (statusOf(createErr) !== 409) throw createErr;
        await increment();
      }
    }
  }

  async forVideo(videoId: string): Promise<Reaction[]> {
    const { resources } = await this.container.items
      .query<Reaction>(
        {
          query: "SELECT c.id, c.videoId, c.emoji, c.videoTime, c.createdAt FROM c WHERE c.videoId = @videoId",
          parameters: [{ name: "@videoId", value: videoId }],
        },
        { partitionKey: videoId },
      )
      .fetchAll();
    return resources;
  }

  async quotaUsed(videoId: string, userId: string): Promise<number> {
    const { resource } = await this.quotas.item(quotaKey(userId), videoId).read<QuotaDoc>();
    return resource?.count ?? 0;
  }

  /**
   * One-off cleanup: reactions saved before they were anonymized carry the thrower's userId.
   * Strips it and returns how many were cleaned. Safe to run on every start, and can be
   * removed once it reports 0.
   */
  async scrubLegacyUserIds(): Promise<number> {
    const { resources } = await this.container.items
      .query<{ id: string; videoId: string }>("SELECT c.id, c.videoId FROM c WHERE IS_DEFINED(c.userId)")
      .fetchAll();
    for (const { id, videoId } of resources) {
      await this.container.item(id, videoId).patch([{ op: "remove", path: "/userId" }]);
    }
    return resources.length;
  }

  /** Cross-partition, but DISTINCT keeps the result to one row per video. */
  async reactedVideoIds(): Promise<string[]> {
    const { resources } = await this.container.items.query<string>("SELECT DISTINCT VALUE c.videoId FROM c").fetchAll();
    return resources;
  }

  /** Cross-partition; GROUP BY keeps the result to one row per video and emoji. */
  async countsSince(since: number): Promise<EmojiCount[]> {
    const { resources } = await this.container.items
      .query<EmojiCount>({
        query:
          "SELECT c.videoId, c.emoji, COUNT(1) AS count FROM c WHERE c.createdAt >= @since GROUP BY c.videoId, c.emoji",
        parameters: [{ name: "@since", value: since }],
      })
      .fetchAll();
    return resources;
  }
}
