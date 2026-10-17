import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { estimatePosition, type Peer, type User } from "../types";
import { formatTime } from "../videoId";
import { Avatar } from "./Avatar";

interface Props {
  me: User;
  myTime: number;
  duration: number;
  peers: Map<string, Peer>;
  onSeek: (seconds: number) => void;
}

interface Marker {
  key: string;
  name: string;
  avatar: string | null;
  t: number;
  self: boolean;
  playing: boolean;
}

const MARKER = 28;
const MAX_LANES = 3;

export function Timeline({ me, myTime, duration, peers, onSeek }: Props) {
  const track = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  // Peers are extrapolated between reports, so redraw on a clock rather than only on events.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  useLayoutEffect(() => {
    const el = track.current!;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const markers: Marker[] = useMemo(() => {
    const others = [...peers.values()].map((p) => ({
      key: p.id,
      name: p.user.name,
      avatar: p.user.avatar,
      t: estimatePosition(p, now, duration),
      self: false,
      playing: p.playing,
    }));
    return [{ key: "self", name: me.name, avatar: me.avatar, t: myTime, self: true, playing: false }, ...others].sort(
      (a, b) => a.t - b.t,
    );
  }, [peers, now, duration, me, myTime]);

  const x = (t: number) => (duration > 0 ? Math.min(1, Math.max(0, t / duration)) * width : 0);

  // Stack markers that would overlap into lanes so every viewer stays clickable.
  const laneEnds: number[] = [];
  const placed = markers.map((m) => {
    const left = x(m.t);
    let lane = laneEnds.findIndex((end) => left - end >= MARKER);
    if (lane < 0) lane = laneEnds.length < MAX_LANES ? laneEnds.length : laneEnds.indexOf(Math.min(...laneEnds));
    laneEnds[lane] = left;
    return { ...m, left, lane };
  });
  const lanes = Math.max(1, laneEnds.length);

  const seekFromBar = (e: MouseEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    onSeek(((e.clientX - rect.left) / rect.width) * duration);
  };

  const others = placed.filter((m) => !m.self);

  return (
    <section className="timeline" aria-label="Where everyone is in the video">
      <div className="timeline-track" ref={track}>
        <div className="timeline-markers" style={{ height: lanes * (MARKER + 4) }}>
          {placed.map((m) => (
            <button
              key={m.key}
              type="button"
              className={`marker${m.self ? " marker-self" : ""}`}
              style={{ left: m.left, bottom: m.lane * (MARKER + 4) }}
              title={m.self ? `You · ${formatTime(m.t)}` : `Jump to ${m.name} · ${formatTime(m.t)}`}
              disabled={m.self}
              onClick={() => onSeek(m.t)}
            >
              <Avatar name={m.name} src={m.avatar} size={MARKER - 4} />
            </button>
          ))}
        </div>
        <div className="timeline-bar" onClick={seekFromBar}>
          <div className="timeline-progress" style={{ width: x(myTime) }} />
        </div>
        <div className="timeline-scale">
          <span>{formatTime(myTime)}</span>
          <span>{duration > 0 ? formatTime(duration) : "--:--"}</span>
        </div>
      </div>

      <div className="viewers">
        {others.length === 0 ? (
          <span className="muted">Nobody else is watching right now.</span>
        ) : (
          others.map((m) => (
            <button key={m.key} type="button" className="viewer" onClick={() => onSeek(m.t)} title={`Jump to ${m.name}`}>
              <Avatar name={m.name} src={m.avatar} size={20} />
              <span className="viewer-name">{m.name}</span>
              <span className="viewer-time">
                {m.playing ? "▶" : "❚❚"} {formatTime(m.t)}
              </span>
            </button>
          ))
        )}
      </div>
    </section>
  );
}
