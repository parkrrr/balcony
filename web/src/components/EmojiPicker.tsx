import { useEffect, useRef } from "react";
// Served from our own /assets rather than the library's default CDN; the picker caches it in IndexedDB.
import dataSource from "emoji-picker-element-data/en/emojibase/data.json?url";

interface Props {
  onPick: (emoji: string) => void;
  onClose: () => void;
}

/**
 * Desktop emoji picker, drawn in the system emoji font. The library loads on first open
 * and hides emoji the system font can't draw.
 */
export function EmojiPicker({ onPick, onClose }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onPick, onClose });
  handlers.current = { onPick, onClose };

  useEffect(() => {
    let picker: HTMLElement | undefined;
    let cancelled = false;
    import("emoji-picker-element").then(({ Picker }) => {
      if (cancelled || !host.current) return;
      const p = new Picker({ dataSource });
      p.classList.add("dark");
      p.addEventListener("emoji-click", (e) => e.detail.unicode && handlers.current.onPick(e.detail.unicode));
      host.current.append(p);
      p.shadowRoot?.querySelector<HTMLInputElement>("input[type=search]")?.focus();
      picker = p;
    });

    // The parent wraps this and its toggle button, so a click on the button isn't "outside".
    const outside = (e: PointerEvent) => {
      if (!host.current?.parentElement?.contains(e.target as Node)) handlers.current.onClose();
    };
    const escape = (e: KeyboardEvent) => e.key === "Escape" && handlers.current.onClose();
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      cancelled = true;
      picker?.remove();
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, []);

  return <div ref={host} className="emoji-popover" role="dialog" aria-label="Pick an emoji" />;
}
