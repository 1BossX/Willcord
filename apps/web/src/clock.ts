// Command timestamps come from the main node's clock. The offset measured at
// each snapshot keeps "running for 2m" and "quiet for 1m" right on a browser
// whose own clock is off.
import { useEffect, useState } from "react";

let offset = 0;

export function setServerTime(serverTime: number, local = Date.now()) {
  offset = serverTime - local;
}

/** Main-node time, now. */
export const serverNow = () => Date.now() + offset;

/** Re-renders every second while `active`, returning main-node time. */
export function useNow(active: boolean) {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    if (!active) return;
    setNow(serverNow());
    const timer = setInterval(() => setNow(serverNow()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
