import { useEffect, useState } from "react";

interface Props {
  /** The video being watched, so the pick is always a different one. */
  exclude?: string;
}

/** The die in the search box: opens a random video from all the ones anyone has reacted to. */
export function RandomVideo({ exclude }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The error floats over the page, so it shouldn't linger.
  useEffect(() => {
    if (!error) return;
    const id = setTimeout(() => setError(null), 4_000);
    return () => clearTimeout(id);
  }, [error]);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const query = exclude ? `?exclude=${encodeURIComponent(exclude)}` : "";
      const res = await fetch(`/api/random-video${query}`);
      const body: { videoId?: string; error?: string } = await res.json();
      if (res.ok && body.videoId) return window.location.assign(`/watch?v=${body.videoId}`);
      setError(body.error ?? "Couldn't pick a video. Try again.");
    } catch {
      setError("Couldn't pick a video. Try again.");
    }
    setBusy(false);
  };

  return (
    <span className="random-video">
      <button type="button" onClick={go} disabled={busy} title="Random video" aria-label="Random video">
        🎲
      </button>
      {error && (
        <span className="search-error" role="status">
          {error}
        </span>
      )}
    </span>
  );
}
