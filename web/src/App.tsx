import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Chat } from "./components/Chat";
import { Player, type PlayerTick } from "./components/Player";
import { Timeline } from "./components/Timeline";
import type { User } from "./types";
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

function Watch({ videoId, me }: { videoId: string; me: User }) {
  const room = useRoom(videoId);
  const player = useRef<YT.Player | null>(null);
  const [tick, setTick] = useState<PlayerTick>({ t: 0, playing: false, rate: 1, duration: 0 });

  // The session expired mid-visit; reloading lands on the sign-in screen.
  useEffect(() => {
    if (room.status === "unauthorized") window.location.reload();
  }, [room.status]);

  const onTick = useCallback(
    (next: PlayerTick) => {
      setTick(next);
      room.report({ t: next.t, playing: next.playing, rate: next.rate });
    },
    [room.report],
  );

  const seek = useCallback((seconds: number) => {
    player.current?.seekTo(seconds, true);
  }, []);

  const send = useCallback(
    (text: string) => room.send(text, player.current ? player.current.getCurrentTime() : null),
    [room.send],
  );

  return (
    <div className="watch">
      <main className="stage">
        <Player videoId={videoId} onReady={(p) => (player.current = p)} onTick={onTick} />
        <Timeline me={me} myTime={tick.t} duration={tick.duration} peers={room.peers} onSeek={seek} />
      </main>
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
