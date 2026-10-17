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

export class MemoryStore implements MessageStore {
  private readonly byVideo = new Map<string, ChatMessage[]>();

  constructor(private readonly keep = 500) {}

  async add(message: ChatMessage): Promise<void> {
    const list = this.byVideo.get(message.videoId) ?? [];
    list.push(message);
    if (list.length > this.keep) list.splice(0, list.length - this.keep);
    this.byVideo.set(message.videoId, list);
  }

  async recent(videoId: string, limit: number): Promise<ChatMessage[]> {
    return (this.byVideo.get(videoId) ?? []).slice(-limit);
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

/** Anonymous on purpose: no name or avatar, so reactions sit outside the 30-day limit on stored YouTube data. */
export interface Reaction {
  id: string;
  videoId: string;
  userId: string;
  emoji: string;
  /** Thrower's playback position in seconds; the reaction replays when anyone's playhead reaches it. */
  videoTime: number;
  createdAt: number;
}

export interface ReactionStore {
  add(reaction: Reaction): Promise<void>;
  /** Every reaction on a video, in no particular order. */
  forVideo(videoId: string): Promise<Reaction[]>;
  countByUser(videoId: string, userId: string): Promise<number>;
}

export class MemoryReactionStore implements ReactionStore {
  private readonly byVideo = new Map<string, Reaction[]>();

  async add(reaction: Reaction): Promise<void> {
    const list = this.byVideo.get(reaction.videoId) ?? [];
    list.push(reaction);
    this.byVideo.set(reaction.videoId, list);
  }

  async forVideo(videoId: string): Promise<Reaction[]> {
    return [...(this.byVideo.get(videoId) ?? [])];
  }

  async countByUser(videoId: string, userId: string): Promise<number> {
    return (this.byVideo.get(videoId) ?? []).filter((r) => r.userId === userId).length;
  }
}

/** Partitioned on /videoId like messages, so both queries stay in one partition. */
export class CosmosReactionStore implements ReactionStore {
  private readonly container: Container;

  constructor(endpoint: string, database: string, container: string) {
    const client = new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });
    this.container = client.database(database).container(container);
  }

  async add(reaction: Reaction): Promise<void> {
    await this.container.items.create(reaction);
  }

  async forVideo(videoId: string): Promise<Reaction[]> {
    const { resources } = await this.container.items
      .query<Reaction>(
        {
          query: "SELECT c.id, c.videoId, c.userId, c.emoji, c.videoTime, c.createdAt FROM c WHERE c.videoId = @videoId",
          parameters: [{ name: "@videoId", value: videoId }],
        },
        { partitionKey: videoId },
      )
      .fetchAll();
    return resources;
  }

  async countByUser(videoId: string, userId: string): Promise<number> {
    const { resources } = await this.container.items
      .query<number>(
        {
          query: "SELECT VALUE COUNT(1) FROM c WHERE c.videoId = @videoId AND c.userId = @userId",
          parameters: [
            { name: "@videoId", value: videoId },
            { name: "@userId", value: userId },
          ],
        },
        { partitionKey: videoId },
      )
      .fetchAll();
    return resources[0] ?? 0;
  }
}
