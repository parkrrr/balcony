import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { RoomStatus } from "../useRoom";
import type { ChatMessage } from "../types";
import { formatTime } from "../videoId";
import { Avatar } from "./Avatar";

interface Props {
  messages: ChatMessage[];
  status: RoomStatus;
  viewers: number;
  onSend: (text: string) => Promise<string | null>;
  onSeek: (seconds: number) => void;
}

const STICK_THRESHOLD_PX = 48;

export function Chat({ messages, status, viewers, onSend, onSeek }: Props) {
  const list = useRef<HTMLOListElement>(null);
  const pinned = useRef(true);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // Follow new messages only while the reader is at the bottom, so scrolling back isn't yanked away.
  useLayoutEffect(() => {
    const el = list.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const el = list.current!;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    const err = await onSend(text);
    setSending(false);
    setError(err);
    if (!err) {
      setDraft("");
      pinned.current = true;
    }
  };

  return (
    <aside className="chat">
      <header className="chat-header">
        <span>Live chat</span>
        <span className={`status status-${status}`}>
          {status === "connected" ? `${viewers} watching` : status === "connecting" ? "Connecting…" : "Offline"}
        </span>
      </header>

      <ol className="chat-messages" ref={list} onScroll={onScroll} aria-live="polite">
        {messages.length === 0 && <li className="chat-empty muted">No messages yet. Say hi!</li>}
        {messages.map((m) => (
          <li key={m.id} className="chat-message">
            <Avatar name={m.name} src={m.avatar} size={24} />
            <div>
              <span className="chat-name">{m.name}</span>
              {m.videoTime != null && (
                <button type="button" className="chat-time" onClick={() => onSeek(m.videoTime!)} title="Jump to this moment">
                  {formatTime(m.videoTime)}
                </button>
              )}
              <span className="chat-text">{m.text}</span>
            </div>
          </li>
        ))}
      </ol>

      <form className="chat-form" onSubmit={submit}>
        {error && <div className="chat-error">{error}</div>}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={status === "connected" ? "Chat…" : "Waiting for connection…"}
          maxLength={500}
          disabled={status !== "connected"}
          aria-label="Chat message"
        />
        <button type="submit" disabled={status !== "connected" || sending || !draft.trim()}>
          Send
        </button>
      </form>
    </aside>
  );
}
