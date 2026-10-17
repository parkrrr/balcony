export interface User {
  id: string;
  name: string;
  avatar: string | null;
  channelId: string | null;
}

export interface ChatMessage {
  id: string;
  videoId: string;
  userId: string;
  name: string;
  avatar: string | null;
  text: string;
  videoTime: number | null;
  createdAt: number;
}

export interface Peer {
  id: string;
  user: { id: string; name: string; avatar: string | null };
  t: number;
  playing: boolean;
  rate: number;
  /** Local clock (ms) when this report arrived; used to extrapolate where they are now. */
  at: number;
}

/** Where a peer probably is right now, assuming they kept playing at the same rate. */
export function estimatePosition(peer: Peer, now: number, duration: number): number {
  const t = peer.playing ? peer.t + ((now - peer.at) / 1000) * peer.rate : peer.t;
  return duration > 0 ? Math.min(t, duration) : t;
}
