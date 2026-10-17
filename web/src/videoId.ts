const ID = /^[A-Za-z0-9_-]{11}$/;

export const isVideoId = (v: string | null | undefined): v is string => !!v && ID.test(v);

/** Accepts a bare ID or any common YouTube URL shape (watch, youtu.be, shorts, embed, live). */
export function parseVideoId(input: string): string | null {
  const text = input.trim();
  if (ID.test(text)) return text;
  let url: URL;
  try {
    url = new URL(text.includes("://") ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www\.|m\.|music\.)/, "");
  if (host === "youtu.be") return isVideoId(url.pathname.slice(1)) ? url.pathname.slice(1) : null;
  if (host !== "youtube.com" && host !== "youtube-nocookie.com") return null;
  const v = url.searchParams.get("v");
  if (isVideoId(v)) return v;
  const match = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
  return match ? match[1] : null;
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
