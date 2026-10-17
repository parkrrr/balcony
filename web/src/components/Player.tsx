import { useEffect, useRef, useState, type Ref } from "react";
import { loadYouTubeApi } from "../youtube";

export interface PlayerTick {
  t: number;
  playing: boolean;
  rate: number;
  duration: number;
}

interface Props {
  ref?: Ref<HTMLDivElement>;
  videoId: string;
  onReady: (player: YT.Player) => void;
  onTick: (tick: PlayerTick) => void;
}

const TICK_MS = 500;

export function Player({ ref, videoId, onReady, onTick }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onReady, onTick });
  callbacks.current = { onReady, onTick };
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = host.current!;
    // The API replaces its target element with an iframe, so give it one React doesn't own.
    const target = document.createElement("div");
    container.replaceChildren(target);
    setError(null);

    let player: YT.Player | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    let cancelled = false;

    const tick = () => {
      if (!player?.getCurrentTime) return;
      callbacks.current.onTick({
        t: player.getCurrentTime() ?? 0,
        playing: player.getPlayerState() === YT.PlayerState.PLAYING,
        rate: player.getPlaybackRate() ?? 1,
        duration: player.getDuration() ?? 0,
      });
    };

    loadYouTubeApi().then(
      (api) => {
        if (cancelled) return;
        player = new api.Player(target, {
          videoId,
          width: "100%",
          height: "100%",
          playerVars: { playsinline: 1, rel: 0, origin: window.location.origin },
          events: {
            onReady: () => {
              callbacks.current.onReady(player!);
              tick();
              timer = setInterval(tick, TICK_MS);
            },
            onStateChange: tick,
            onPlaybackRateChange: tick,
            onError: (e) => setError(playerError(e.data)),
          },
        });
      },
      (err: Error) => setError(err.message),
    );

    return () => {
      cancelled = true;
      clearInterval(timer);
      player?.destroy();
      container.replaceChildren();
    };
  }, [videoId]);

  return (
    <div ref={ref} className="player">
      <div ref={host} className="player-frame" />
      {error && <div className="player-error">{error}</div>}
    </div>
  );
}

function playerError(code: YT.PlayerError): string {
  switch (code) {
    case 2:
      return "That doesn't look like a valid video.";
    case 100:
      return "This video was removed or made private.";
    case 101:
    case 150:
      return "The owner doesn't allow this video to play outside YouTube.";
    default:
      return "The video couldn't be played.";
  }
}
