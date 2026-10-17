import { useEffect, useState } from "react";
import type { MostReacted as Video } from "../types";

const compact = new Intl.NumberFormat(undefined, { notation: "compact" });

/** The week's most reacted videos. Renders nothing until there's something to show. */
export function MostReacted() {
  const [videos, setVideos] = useState<Video[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/most-reacted", { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : []))
      .then(setVideos, () => {});
    return () => controller.abort();
  }, []);

  if (!videos.length) return null;

  return (
    <section className="most-reacted" aria-labelledby="most-reacted-heading">
      <h2 id="most-reacted-heading">Most reacted this week</h2>
      <ol>
        {videos.map((v) => (
          <li key={v.videoId}>
            <a className="most-reacted-item" href={`/watch?v=${v.videoId}`}>
              <img src={`https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`} alt="" loading="lazy" />
              <div className="most-reacted-info">
                <span className="most-reacted-title">{v.title ?? "Untitled video"}</span>
                {v.channel && <span className="muted">{v.channel}</span>}
                <span className="most-reacted-summary">
                  {v.top.map((e) => (
                    <span key={e.emoji} className="most-reacted-emoji" title={`${e.count} × ${e.emoji}`}>
                      {e.emoji} {compact.format(e.count)}
                    </span>
                  ))}
                  <span className="muted">
                    {compact.format(v.total)} {v.total === 1 ? "reaction" : "reactions"}
                  </span>
                </span>
              </div>
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}
