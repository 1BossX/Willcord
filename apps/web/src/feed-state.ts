// What the UI holds from the main node: one snapshot, then feed events applied
// in order. Pure, so the rules (each event once, latest state per entity, only
// the open session's records) are tested without a browser.

export type FeedEvent = {
  event_id: number;
  kind: string;
  entity_id: string;
  session_id: string | null;
  job_id: string | null;
  data: any;
};

type Row = Record<string, any>;
export type Dispatch = { paused: number; reason: string | null; note: string | null; since: number | null };
export type Alert = { event_id: number; alert_id: string; type: string; severity: "info" | "warn" | "error"; worker_id?: string | null; job_id?: string | null; message: string; created_at: number };
export type Snapshot = {
  cursor: number;
  server_time?: number;
  main_session_id: string;
  workers: Row[];
  /** Whether the main node starts work; paused after a restore, on low disk or by an operator. */
  dispatch?: Dispatch;
  /** Newest device alerts first (#86). */
  alerts?: Alert[];
  sessions: Row[];
  session: { session: Row; messages: Row[]; jobs: Row[]; calls: Row[]; logs: Row[]; drafts: Row[] } | null;
};

export type FeedState = {
  /** The last event applied; anything at or below it is a repeat. */
  cursor: number;
  sessionId: string | null;
  mainSessionId: string | null;
  workers: Record<string, Row>;
  dispatch: Dispatch | null;
  sessions: Record<string, Row>;
  messages: Record<string, Row>;
  jobs: Record<string, Row>;
  /** Keyed `job_id/call_id`. */
  calls: Record<string, Row>;
  /** Keyed `job_id/call_id/stream`. */
  logs: Record<string, Row>;
  drafts: Record<string, Row>;
  /** Bumped by events that change what the attention panel shows. */
  attentionVersion: number;
  /** Newest device alerts first (#86). */
  alerts: Alert[];
};

export const emptyFeed = (sessionId: string | null = null): FeedState => ({
  cursor: 0, sessionId, mainSessionId: null, workers: {}, dispatch: null, sessions: {}, messages: {}, jobs: {}, calls: {}, logs: {}, drafts: {}, attentionVersion: 0, alerts: [],
});

const byKey = (rows: Row[], key: (row: Row) => string) => Object.fromEntries(rows.map((row) => [key(row), row]));
const callKey = (row: Row) => `${row.job_id}/${row.call_id}`;
const logKey = (row: Row) => `${row.job_id}/${row.call_id}/${row.stream}`;

export function fromSnapshot(snapshot: Snapshot, sessionId: string | null, attentionVersion = 0): FeedState {
  const s = snapshot.session;
  return {
    cursor: snapshot.cursor,
    sessionId: s ? sessionId : null,
    mainSessionId: snapshot.main_session_id,
    workers: byKey(snapshot.workers, (w) => w.worker_id),
    dispatch: snapshot.dispatch ?? null,
    sessions: byKey(snapshot.sessions, (x) => x.session_id),
    messages: s ? byKey(s.messages, (m) => m.message_id) : {},
    jobs: s ? byKey(s.jobs, (j) => j.job_id) : {},
    calls: s ? byKey(s.calls, callKey) : {},
    logs: s ? byKey(s.logs, logKey) : {},
    drafts: s ? byKey(s.drafts, (d) => d.draft_id) : {},
    attentionVersion: attentionVersion + 1,
    alerts: snapshot.alerts ?? [],
  };
}

function put(map: Record<string, Row>, key: string, value: Row | null) {
  const next = { ...map };
  if (value) next[key] = value; else delete next[key];
  return next;
}

/** One feed event. A repeat, or a record of another session, leaves the state unchanged. */
export function applyEvent(state: FeedState, e: FeedEvent): FeedState {
  if (e.event_id <= state.cursor) return state;
  const next = { ...state, cursor: e.event_id };
  const mine = e.session_id !== null && e.session_id === state.sessionId;
  switch (e.kind) {
    case "worker":
      return { ...next, workers: put(state.workers, e.entity_id, e.data), attentionVersion: state.attentionVersion + 1 };
    case "dispatch":
      return { ...next, dispatch: e.data };
    case "session":
      return { ...next, sessions: put(state.sessions, e.entity_id, e.data) };
    case "attention":
      return { ...next, attentionVersion: state.attentionVersion + 1 };
    case "alert":
      return e.data ? { ...next, alerts: [e.data, ...state.alerts].slice(0, 20), attentionVersion: state.attentionVersion + 1 } : next;
    case "job":
      if (!mine) return next;
      return { ...next, jobs: put(state.jobs, e.entity_id, e.data), attentionVersion: e.data?.state === "needs_attention" || state.jobs[e.entity_id]?.state === "needs_attention" ? state.attentionVersion + 1 : state.attentionVersion };
    case "message":
      return mine ? { ...next, messages: put(state.messages, e.entity_id, e.data) } : next;
    case "call":
      return mine ? { ...next, calls: put(state.calls, `${e.job_id}/${e.entity_id}`, e.data) } : next;
    case "log":
      return mine ? { ...next, logs: put(state.logs, `${e.job_id}/${e.entity_id}`, e.data) } : next;
    case "draft":
      // A committed draft is now a message; showing both would repeat the answer.
      return mine ? { ...next, drafts: put(state.drafts, e.entity_id, e.data?.state === "committed" ? null : e.data) } : next;
    default:
      return next;
  }
}

/** Cursor markers move past events the server coalesced away. */
export function advanceCursor(state: FeedState, cursor: number): FeedState {
  return cursor > state.cursor ? { ...state, cursor } : state;
}
