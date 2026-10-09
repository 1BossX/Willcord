// A minimal SSE reader over real HTTP: Fastify's inject cannot stream.
import { waitFor } from "./worker-harness.js";

export type SseMessage = { id?: number; event: string; data: any };

export function openEvents(port: number, cookie: string, query: { after?: number; lastEventId?: number }) {
  const controller = new AbortController();
  const messages: SseMessage[] = [];
  let ended = false, status = 0;
  const url = `http://127.0.0.1:${port}/api/events${query.after === undefined ? "" : `?after=${query.after}`}`;
  const headers: Record<string, string> = { cookie, accept: "text/event-stream" };
  if (query.lastEventId !== undefined) headers["last-event-id"] = String(query.lastEventId);
  const done = (async () => {
    try {
      const response = await fetch(url, { headers, signal: controller.signal });
      status = response.status;
      if (!response.body) return;
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body as any) {
        buffer += decoder.decode(chunk, { stream: true });
        let cut;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
          const message: SseMessage = { event: "message", data: undefined };
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("id: ")) message.id = Number(line.slice(4));
            else if (line.startsWith("event: ")) message.event = line.slice(7);
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (!data) continue;
          message.data = JSON.parse(data);
          messages.push(message);
        }
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") throw error;
    } finally { ended = true; }
  })();
  return {
    messages,
    get ended() { return ended; },
    get status() { return status; },
    /** Feed events only, without cursor markers. */
    events: () => messages.filter((m) => m.event !== "cursor" && m.event !== "reset").map((m) => m.data),
    until: (check: () => boolean, timeoutMs = 20000) => waitFor(check, timeoutMs),
    close: async () => { controller.abort(); await done; },
    done,
  };
}

/** Apply feed events the way the UI does: latest state per entity, each event_id once. */
export function fold(events: Array<{ event_id: number; kind: string; entity_id: string; job_id: string | null; data: any }>) {
  const state = new Map<string, any>();
  const seen = new Set<number>();
  for (const e of events) {
    if (seen.has(e.event_id)) continue;
    seen.add(e.event_id);
    state.set(`${e.kind}:${e.kind === "call" || e.kind === "log" ? `${e.job_id}/` : ""}${e.entity_id}`, e.data);
  }
  return state;
}
