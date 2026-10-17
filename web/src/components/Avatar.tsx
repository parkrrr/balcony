import { useState } from "react";

interface Props {
  name: string;
  src: string | null;
  size?: number;
}

export function Avatar({ name, src, size = 24 }: Props) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size, fontSize: size * 0.45 };
  if (!src || failed) {
    return (
      <span className="avatar avatar-fallback" style={{ ...style, background: colorFor(name) }} aria-hidden>
        {name.trim().charAt(0).toUpperCase() || "?"}
      </span>
    );
  }
  return (
    <img
      className="avatar"
      style={style}
      src={src}
      alt=""
      // Google's avatar CDN sometimes refuses requests that carry a third-party referrer.
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

function colorFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 45% 42%)`;
}
