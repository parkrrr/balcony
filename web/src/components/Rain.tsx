import { useImperativeHandle, useRef, type Ref, type RefObject } from "react";

export interface RainHandle {
  drop: (emoji: string) => void;
}

interface Props {
  ref: Ref<RainHandle>;
  /** Drops aim for the gutters beside this element, since anything behind it is hidden. */
  avoid: RefObject<HTMLElement | null>;
}

// Purely a performance cap. A real pile-up is still obvious at this density.
const MAX_DROPS = 150;
const MIN_SIZE = 28;
const MAX_SIZE = 44;
const GAP = 8;

const between = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

/**
 * Emoji falling down the page background. YouTube forbids drawing anything in front of the
 * embedded player, so this layer sits underneath the stage: the opaque player covers any drop
 * that passes behind it, and nothing here ever paints on top of the video.
 */
export function Rain({ ref, avoid }: Props) {
  const layer = useRef<HTMLDivElement>(null);

  useImperativeHandle(
    ref,
    () => ({
      drop(emoji) {
        const el = layer.current;
        if (!el || el.childElementCount >= MAX_DROPS) return;
        const box = el.getBoundingClientRect();
        const size = Math.round(between(MIN_SIZE, MAX_SIZE));

        // Prefer the strips left and right of the player, weighted by width, so the drop is seen.
        let x = between(0, Math.max(0, box.width - size));
        const hole = avoid.current?.getBoundingClientRect();
        if (hole) {
          const left = Math.max(0, hole.left - box.left - GAP - size);
          const rightStart = hole.right - box.left + GAP;
          const right = Math.max(0, box.width - rightStart - size);
          if (left + right > 0) {
            const pick = Math.random() * (left + right);
            x = pick < left ? pick : rightStart + (pick - left);
          }
        }

        const drop = document.createElement("span");
        drop.className = "rain-drop";
        drop.textContent = emoji;
        drop.setAttribute("aria-hidden", "true");
        const style = drop.style;
        style.setProperty("--x", `${x}px`);
        style.setProperty("--y", `${between(0.1, 0.6) * box.height}px`);
        style.setProperty("--size", `${size}px`);
        style.setProperty("--fall", `${box.height + size * 2}px`);
        style.setProperty("--drift", `${between(-24, 24)}px`);
        style.setProperty("--spin", `${between(-120, 120)}deg`);
        style.setProperty("--duration", `${between(3.5, 5.5)}s`);
        drop.addEventListener("animationend", () => drop.remove(), { once: true });
        el.append(drop);
      },
    }),
    [avoid],
  );

  return <div ref={layer} className="rain" />;
}
