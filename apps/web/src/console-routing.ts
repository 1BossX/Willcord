/** Deep links for the console SPA; paths live in the URL hash so refresh and share work without server routes. */
export type ConsoleRoute =
  | { view: "home" }
  | { view: "main" }
  | { view: "worker"; workerId: string }
  | { view: "session"; sessionId: string };

export function routeToHash(route: ConsoleRoute): string {
  switch (route.view) {
    case "home":
      return "#/";
    case "main":
      return "#/main";
    case "worker":
      return `#/worker/${encodeURIComponent(route.workerId)}`;
    case "session":
      return `#/session/${encodeURIComponent(route.sessionId)}`;
  }
}

export function parseRouteHash(hash: string): ConsoleRoute | null {
  const path = hash.replace(/^#/, "").replace(/^\//, "") || "";
  if (!path || path === "/") return { view: "home" };
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "main" && parts.length === 1) return { view: "main" };
  if (parts[0] === "worker" && parts[1]) return { view: "worker", workerId: decodeURIComponent(parts[1]) };
  if (parts[0] === "session" && parts[1]) return { view: "session", sessionId: decodeURIComponent(parts[1]) };
  return null;
}

export function writeRoute(route: ConsoleRoute) {
  const next = routeToHash(route);
  if (window.location.hash === next) return;
  window.history.pushState(null, "", next);
}
