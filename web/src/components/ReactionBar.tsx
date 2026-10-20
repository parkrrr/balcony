import { useEffect, useRef, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";
import { isEmoji, readQuickPicks, recordQuickPick, saveQuickPicks } from "../reactions";
import { EmojiPicker } from "./EmojiPicker";

interface Props {
  connected: boolean;
  show: boolean;
  onShowChange: (show: boolean) => void;
  onThrow: (emoji: string) => Promise<string | null>;
}

// Matches the server's limit of one reaction a second, so the buttons don't invite an error.
const COOLDOWN_MS = 1_000;

// Phones and tablets already have an emoji keyboard, so "+" opens that instead of a picker.
const touchFirst = () => matchMedia("(pointer: coarse)").matches;

export function ReactionBar({ connected, show, onShowChange, onThrow }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [picks, setPicks] = useState(readQuickPicks);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!error) return;
    const id = setTimeout(() => setError(null), 4_000);
    return () => clearTimeout(id);
  }, [error]);

  const disabled = !connected || busy;

  const fire = async (emoji: string) => {
    if (disabled) return false;
    setBusy(true);
    const err = await onThrow(emoji);
    setError(err);
    setTimeout(() => setBusy(false), COOLDOWN_MS);
    if (err) return false;
    const now = Date.now();
    setPicks((prev) => {
      const next = recordQuickPick(prev, emoji, now);
      saveQuickPicks(next);
      return next;
    });
    return true;
  };

  const openMore = () => {
    if (!touchFirst()) return setPicking((p) => !p);
    // iOS only raises the keyboard for a focus() inside the tap's own handler.
    flushSync(() => setCustom(""));
    input.current?.focus();
  };

  const pick = async (emoji: string) => {
    if (await fire(emoji)) setPicking(false);
  };

  const submitCustom = async (e: FormEvent) => {
    e.preventDefault();
    const emoji = (custom ?? "").trim();
    if (!isEmoji(emoji)) return setError("Enter a single emoji.");
    if (await fire(emoji)) setCustom(null);
  };

  // An emoji keyboard inserts one emoji per tap, so throw it without waiting for Enter.
  const changeCustom = async (value: string) => {
    setCustom(value);
    if (isEmoji(value.trim()) && (await fire(value.trim()))) setCustom(null);
  };

  return (
    <section className="reaction-bar" aria-label="Reactions">
      <div className="reaction-picks">
        {picks.map(({ emoji }) => (
          <button key={emoji} type="button" className="reaction-pick" disabled={disabled} onClick={() => fire(emoji)} title={`Throw ${emoji}`}>
            {emoji}
          </button>
        ))}
        {custom === null ? (
          <span className="reaction-more-wrap">
            <button
              type="button"
              className="reaction-pick reaction-more"
              disabled={!connected}
              onClick={openMore}
              title="Throw any emoji"
              aria-expanded={picking}
            >
              +
            </button>
            {picking && <EmojiPicker onPick={pick} onClose={() => setPicking(false)} />}
          </span>
        ) : (
          <form className="reaction-custom" onSubmit={submitCustom}>
            <input
              ref={input}
              value={custom}
              onChange={(e) => changeCustom(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setCustom(null)}
              onBlur={() => !custom && setCustom(null)}
              placeholder="Any emoji"
              enterKeyHint="send"
              maxLength={32}
              aria-label="Emoji to throw"
            />
            <button type="submit" disabled={disabled}>
              Throw
            </button>
          </form>
        )}
      </div>

      <label className="reaction-switch">
        <input type="checkbox" checked={show} onChange={(e) => onShowChange(e.target.checked)} />
        Show reactions
      </label>

      {error && (
        <div className="reaction-error" role="status">
          {error}
        </div>
      )}
    </section>
  );
}
