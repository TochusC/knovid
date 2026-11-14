type Route = {
  page: "landing" | "home" | "projects" | "project" | "styles" | "rixin";
  projectId?: string;
  stylePresetId?: string;
};

export function readRoute({ pathname, searchParams }: URL): Route {
  const path = pathname.replace(/\/$/, "");
  switch (path) {
    case "/workspace":
      return { page: "home", stylePresetId: searchParams.get("style") ?? undefined };
    case "/projects":
      return { page: "projects" };
    case "/styles":
      return { page: "styles" };
    case "/rixin":
      return { page: "rixin" };
    default: {
      const project = /^\/projects\/([^/]+)$/.exec(path);
      if (project) {
        try {
          return { page: "project", projectId: decodeURIComponent(project[1]) };
        } catch {
          return { page: "landing" };
        }
      }
      return { page: "landing" };
    }
  }
}

export function legacyRoute(location: URL): URL | null {
  if (location.pathname !== "/" || !location.hash) return null;

  const fragment = location.hash.slice(1);
  if (!/^\/?(?:workspace|projects|styles|rixin)(?:[/?#]|$)/.test(fragment) &&
      !/^\/(?:[?#]|$)/.test(fragment)) return null;

  const path = fragment.startsWith("/") ? fragment : `/${fragment}`;
  const route = new URL(path, location.origin);
  if (route.origin !== location.origin || (route.pathname !== "/" && readRoute(route).page === "landing")) return null;

  const routeKeys = new Set(route.searchParams.keys());
  for (const [key, value] of location.searchParams) {
    if (!routeKeys.has(key)) route.searchParams.append(key, value);
  }
  return route;
}
