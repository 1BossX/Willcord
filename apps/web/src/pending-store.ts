// One poll of the device list feeds the sidebar badge and the home page, so a
// worker that has just applied is visible without opening the dialog.
let pendingCount = 0;
const subscribers = new Set<() => void>();
let poller: ReturnType<typeof setInterval> | undefined;
export const POLL_MS = 8000;

let load: () => Promise<number> = async () => 0;
/** How to learn the number of devices waiting for approval (the app injects its API call). */
export function setPendingLoader(loader: () => Promise<number>) { load = loader; }

async function pollPending() {
  try {
    const count = await load();
    if (count !== pendingCount) { pendingCount = count; subscribers.forEach(notify => notify()); }
  } catch { /* signed out or offline: keep the last count */ }
}
export const refreshPending = () => void pollPending();
export const getPendingCount = () => pendingCount;

/**
 * The first subscriber polls at once and starts the interval; the last one
 * stops it. Must keep a stable identity when handed to useSyncExternalStore:
 * resubscribing on every render would poll on every render.
 */
export function subscribePending(notify: () => void) {
  subscribers.add(notify);
  if (subscribers.size === 1) { void pollPending(); poller = setInterval(() => void pollPending(), POLL_MS); }
  return () => {
    subscribers.delete(notify);
    if (!subscribers.size) { clearInterval(poller); poller = undefined; }
  };
}
