import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Chat } from "./components/Chat";
import { Player, type PlayerTick } from "./components/Player";
import { Rain, type RainHandle } from "./components/Rain";
import { ReactionBar } from "./components/ReactionBar";
import { Timeline } from "./components/Timeline";
import { between } from "./reactions";
import type { Reaction, User } from "./types";
import { useRoom } from "./useRoom";
import { isVideoId, parseVideoId } from "./videoId";

const here = () => window.location.pathname + window.location.search;

export function App() {
  const [me, setMe] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    fetch("/api/me", { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : null))
      .then(setMe, () => setMe(null));
  }, []);

  // Mirrors YouTube's own URL shape, so swapping the domain on a watch link just works.
  const videoId = window.location.pathname === "/watch" ? new URLSearchParams(window.location.search).get("v") : null;

  if (me === undefined) return <div className="center muted">Loading…</div>;
  if (me === null) return <SignIn />;

  return (
    <div className="app">
      <TopBar me={me} />
      {isVideoId(videoId) ? <Watch key={videoId} videoId={videoId} me={me} /> : <Home />}
    </div>
  );
}

function SignIn() {
  return (
    <div className="center">
      <div className="card">
        <h1 className="brand-large">
          <Logo /> Balcony
        </h1>
        <p>The best seats for watching YouTube together. Chat alongside any video and see where everyone else is.</p>
        <a className="button-primary" href={`/auth/login?returnTo=${encodeURIComponent(here())}`}>
          Sign in with Google
        </a>
        <p className="fine-print">
          We only read your channel name and picture. Ads and YouTube Premium follow whichever Google account is
          signed in to youtube.com in this browser.
        </p>
      </div>
    </div>
  );
}

function TopBar({ me }: { me: User }) {
  const signOut = async () => {
    await fetch("/auth/logout", { method: "POST" });
    window.location.reload();
  };
  return (
    <header className="topbar">
      <a className="brand" href="/">
        <Logo /> Balcony
      </a>
      <VideoForm compact />
      <div className="me">
        <span className="me-name">{me.name}</span>
        <button type="button" className="link" onClick={signOut}>
          Sign out
        </button>
      </div>
    </header>
  );
}

function Home() {
  return (
    <div className="center">
      <div className="card">
        <h1>Pick a video</h1>
        <p className="muted">Paste a YouTube link or video ID to open its chat room.</p>
        <VideoForm />
      </div>
    </div>
  );
}

function VideoForm({ compact = false }: { compact?: boolean }) {
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const id = parseVideoId(value);
    if (!id) return setInvalid(true);
    window.location.assign(`/watch?v=${id}`);
  };
  return (
    <form className={`video-form${compact ? " compact" : ""}`} onSubmit={submit}>
      <input
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setInvalid(false);
        }}
        placeholder="https://www.youtube.com/watch?v=…"
        aria-label="YouTube link or video ID"
        aria-invalid={invalid}
      />
      <button type="submit">Open</button>
      {invalid && !compact && <div className="form-error">That doesn't look like a YouTube video link.</div>}
    </form>
  );
}

// The longest jump between two ticks that still counts as normal playback (ticks are ~0.5s, at up to 2x).
// Anything bigger is a seek, and seeking shouldn't fire a burst of everything skipped over.
const MAX_PLAYBACK_STEP_S = 2.5;
// A reaction from someone slightly behind us in the video still plays, so a room watching
// together sees each other's reactions even when their playheads drift a little.
const LIVE_GRACE_S = 3;
const SHOW_REACTIONS_KEY = "balcony.showReactions";

function readShowReactions(): boolean {
  try {
    return localStorage.getItem(SHOW_REACTIONS_KEY) !== "off";
  } catch {
    return true;
  }
}

function Watch({ videoId, me }: { videoId: string; me: User }) {
  const player = useRef<YT.Player | null>(null);
  const playerBox = useRef<HTMLDivElement>(null);
  const rain = useRef<RainHandle>(null);
  const [tick, setTick] = useState<PlayerTick>({ t: 0, playing: false, rate: 1, duration: 0 });
  const lastTick = useRef<PlayerTick | null>(null);
  const [showReactions, setShowReactions] = useState(readShowReactions);
  const show = useRef(showReactions);
  show.current = showReactions;
  // Our own reactions drop as soon as the server accepts them, so replay skips them once.
  const skipOnce = useRef(new Set<string>());

  const onLiveReaction = useCallback((r: Reaction) => {
    const now = lastTick.current;
    // Reactions ahead of our playhead are left for the replay to play on time.
    if (show.current && now?.playing && r.videoTime <= now.t && now.t - r.videoTime <= LIVE_GRACE_S) {
      rain.current?.drop(r.emoji);
    }
  }, []);

  const room = useRoom(videoId, onLiveReaction);
  const reactions = useRef(room.reactions);
  reactions.current = room.reactions;

  // The session expired mid-visit; reloading lands on the sign-in screen.
  useEffect(() => {
    if (room.status === "unauthorized") window.location.reload();
  }, [room.status]);

  const onTick = useCallback(
    (next: PlayerTick) => {
      const prev = lastTick.current;
      lastTick.current = next;
      setTick(next);
      room.report({ t: next.t, playing: next.playing, rate: next.rate });

      const step = prev ? next.t - prev.t : 0;
      if (!prev || !next.playing || !show.current || step <= 0 || step > MAX_PLAYBACK_STEP_S) return;
      for (const r of between(reactions.current, prev.t, next.t)) {
        if (!skipOnce.current.delete(r.id)) rain.current?.drop(r.emoji);
      }
    },
    [room.report],
  );

  const changeShowReactions = (on: boolean) => {
    setShowReactions(on);
    try {
      localStorage.setItem(SHOW_REACTIONS_KEY, on ? "on" : "off");
    } catch {
      // Storage is blocked; the choice just won't outlive this page.
    }
  };

  const throwReaction = useCallback(
    async (emoji: string): Promise<string | null> => {
      if (!player.current) return "The video isn't ready yet.";
      const res = await room.react(emoji, player.current.getCurrentTime());
      if ("error" in res) return res.error;
      if (show.current) rain.current?.drop(emoji);
      const now = lastTick.current;
      if (now && res.reaction.videoTime > now.t) skipOnce.current.add(res.reaction.id);
      return null;
    },
    [room.react],
  );

  const seek = useCallback((seconds: number) => {
    player.current?.seekTo(seconds, true);
  }, []);

  const send = useCallback(
    (text: string) => room.send(text, player.current ? player.current.getCurrentTime() : null),
    [room.send],
  );

  return (
    <div className={`watch${showReactions ? " reactions-on" : ""}`}>
      <div className="stage-wrap">
        {showReactions && <Rain ref={rain} avoid={playerBox} />}
        <main className="stage">
          <Player ref={playerBox} videoId={videoId} onReady={(p) => (player.current = p)} onTick={onTick} />
          <ReactionBar
            connected={room.status === "connected"}
            show={showReactions}
            onShowChange={changeShowReactions}
            onThrow={throwReaction}
          />
          <Timeline
            me={me}
            myTime={tick.t}
            duration={tick.duration}
            peers={room.peers}
            reactions={showReactions ? room.reactions : null}
            onSeek={seek}
          />
        </main>
      </div>
      <Chat messages={room.messages} status={room.status} viewers={room.peers.size + 1} onSend={send} onSeek={seek} />
    </div>
  );
}

/** Two heads leaning over a theater balcony rail. Keep in sync with the favicon in index.html. */
function Logo() {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="7" fill="var(--accent)" />
      <g fill="var(--on-accent)">
        <circle cx="11" cy="8.5" r="3" />
        <path d="M5.5 17a5.5 5 0 0 1 11 0z" />
        <circle cx="21" cy="8" r="3" />
        <path d="M15.5 17a5.5 5 0 0 1 11 0z" />
        <rect x="4" y="16" width="24" height="2.5" rx="1.25" />
        <path d="M6 18h2v6H6zM10.5 18h2v6h-2zM15 18h2v6h-2zM19.5 18h2v6h-2zM24 18h2v6h-2z" />
        <rect x="4" y="24" width="24" height="2.5" rx="1.25" />
      </g>
    </svg>
  );
}
