// The browser's only view of the main node: a snapshot with a cursor, then the
// SSE feed from that cursor. EventSource reconnects with Last-Event-ID; a reset
// (expired cursor) or a stream that cannot reconnect starts over from a snapshot.
import { useEffect, useState } from "react";
import { ApiError, request } from "./api";
import { advanceCursor, applyEvent, emptyFeed, fromSnapshot, type FeedState, type Snapshot } from "./feed-state";

export type Connection = "connecting" | "live" | "reconnecting";
const KINDS = ["job", "message", "session", "worker", "call", "log", "draft", "attention"];
const RESTART_MS = 3000;

export function useFeed(enabled: boolean, sessionId: string | null, handlers: { onUnauthorized(): void; onError(cause: unknown): void; onMissingSession(): void }) {
  const [state, setState] = useState<FeedState>(() => emptyFeed());
  const [connection, setConnection] = useState<Connection>("connecting");
  useEffect(() => {
    if (!enabled) { setState(emptyFeed()); return; }
    let closed = false, source: EventSource | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    // Another session's records never stay on screen while this one loads.
    setState((s) => ({ ...s, sessionId: null, messages: {}, jobs: {}, calls: {}, logs: {}, drafts: {} }));
    const restart = () => {
      source?.close(); source = undefined;
      if (closed) return;
      setConnection("reconnecting");
      clearTimeout(timer);
      timer = setTimeout(() => void start(), RESTART_MS);
    };
    const start = async () => {
      try {
        const query = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : "";
        const snapshot = await request<Snapshot>(`/api/snapshot${query}`, { signal: controller.signal });
        if (closed) return;
        setState((s) => fromSnapshot(snapshot, sessionId, s.attentionVersion));
        const es = new EventSource(`/api/events?after=${snapshot.cursor}`);
        source = es;
        const apply = (message: MessageEvent) => setState((s) => applyEvent(s, JSON.parse(message.data)));
        for (const kind of KINDS) es.addEventListener(kind, apply as EventListener);
        es.addEventListener("cursor", ((message: MessageEvent) => setState((s) => advanceCursor(s, JSON.parse(message.data).cursor))) as EventListener);
        // The cursor expired: only a new snapshot can be complete.
        es.addEventListener("reset", restart);
        es.onopen = () => setConnection("live");
        es.onerror = () => {
          if (es.readyState !== EventSource.CLOSED) { setConnection("reconnecting"); return; }
          // EventSource gave up (e.g. 401): find out whether the login ended.
          void request<{ authenticated: boolean }>("/auth/session").then(
            (auth) => (auth.authenticated ? restart() : handlers.onUnauthorized()),
            restart,
          );
        };
      } catch (cause) {
        if (closed) return;
        if (cause instanceof ApiError && cause.status === 401) return handlers.onUnauthorized();
        if (cause instanceof ApiError && cause.status === 404 && sessionId) return handlers.onMissingSession();
        handlers.onError(cause);
        restart();
      }
    };
    setConnection("connecting");
    void start();
    return () => { closed = true; controller.abort(); source?.close(); clearTimeout(timer); };
  }, [enabled, sessionId]);
  return { state, connection, loaded: state.sessionId === sessionId && state.mainSessionId !== null };
}
