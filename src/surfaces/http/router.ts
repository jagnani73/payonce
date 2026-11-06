import { readFileSync, readdirSync, type Dirent } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sayError } from "../../text/printable.js";
import { HttpError, sendJson } from "./http.js";

// Local demo server. It binds to loopback only and has no authentication.
export const HOST: string = "127.0.0.1";
// The built page: pnpm build:web writes it, and pnpm ui runs that first.
const PAGE_DIR: string = fileURLToPath(new URL("../../../web/dist/", import.meta.url));
const NOT_BUILT_TEXT: string =
  "The page is not built. Run pnpm build:web, or start PayOnce with pnpm ui, which builds it first";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json; charset=utf-8",
};

export interface RouteCall {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
}

// pattern "/api/home" matches that whole path and nothing else.
// "api/incidents/:id/audit", with no leading slash, matches the path's non-empty
// segments, each :name standing for any one segment, which the handler gets in
// order after the call.
export interface Route {
  method: string;
  pattern: string;
  handler: (call: RouteCall, ...params: string[]) => Promise<void> | void;
}

// The values the pattern's placeholders take, or null when it does not match.
function matched(pattern: string, pathname: string, parts: string[]): string[] | null {
  if (pattern.startsWith("/")) {
    return pattern === pathname ? [] : null;
  }
  const wanted: string[] = pattern.split("/");
  if (wanted.length !== parts.length) {
    return null;
  }
  const params: string[] = [];
  for (const [index, segment] of wanted.entries()) {
    const part: string = parts[index] ?? "";
    if (segment.startsWith(":")) {
      params.push(part);
    } else if (segment !== part) {
      return null;
    }
  }
  return params;
}

// The server has no login, so it only answers its own page. The Host check stops
// DNS rebinding. For writes, the Origin check and the JSON content type stop
// another site open in the same browser from starting or approving a payment.
// A browser says where a request comes from. A page on another site, even one
// that cannot read the answer, could still make the server do the work of an
// answer on every load, or read Airwallex for it, so an API GET it sends is
// refused. The page's own requests are same-origin, and a typed address or a
// bookmark is none. The CLI and curl send neither header.
function crossSite(request: IncomingMessage, host: string): boolean {
  const site: string | string[] | undefined = request.headers["sec-fetch-site"];
  const origin: string | undefined = request.headers.origin;
  return (
    (site !== undefined && site !== "same-origin" && site !== "none") ||
    (origin !== undefined && origin !== `http://${host}`)
  );
}

function guard(request: IncomingMessage, method: string, pathname: string, allowedHosts: ReadonlySet<string>): void {
  const host: string = request.headers.host ?? "";
  if (!allowedHosts.has(host)) {
    throw new HttpError(403, "Forbidden");
  }
  if (method === "GET") {
    if (pathname.startsWith("/api/") && crossSite(request, host)) {
      throw new HttpError(403, "Forbidden");
    }
    return;
  }
  const contentType: string = request.headers["content-type"] ?? "";
  if (
    request.headers.origin !== `http://${host}` ||
    !contentType.startsWith("application/json")
  ) {
    throw new HttpError(403, "Forbidden");
  }
}

// Every file under web/dist/, by its path from there with forward slashes, found
// once when the server starts. None when the page is not built.
function pageFiles(): ReadonlySet<string> {
  let entries: Dirent[];
  try {
    entries = readdirSync(PAGE_DIR, { recursive: true, withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Set<string>();
    }
    throw error;
  }
  return new Set<string>(
    entries
      .filter((entry: Dirent): boolean => entry.isFile())
      .map((entry: Dirent): string => relative(PAGE_DIR, join(entry.parentPath, entry.name)).split(sep).join("/")),
  );
}

// Only the files pageFiles found are served, so a path cannot leave web/dist/.
function serveStatic(response: ServerResponse, pathname: string, files: ReadonlySet<string>): void {
  if (files.size === 0) {
    throw new HttpError(503, NOT_BUILT_TEXT);
  }
  const name: string = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!files.has(name)) {
    throw new HttpError(404, "Not found");
  }
  // Read before any header goes out, so a failed read can still become an error
  // response. A file pnpm build:web --watch writes again is served as it is now.
  const content: Buffer = readFileSync(join(PAGE_DIR, ...name.split("/")));
  // The page has no inline script or style and makes no outside request, so
  // even text that slipped into markup could not run or load anything.
  response.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extname(name)] ?? "application/octet-stream",
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  });
  response.end(content);
}

// Every path outside /api/ is a file of the page. Under /api/ the first route
// whose method and pattern match answers, and none is 404.
async function route(
  routes: readonly Route[],
  allowedHosts: ReadonlySet<string>,
  files: ReadonlySet<string>,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const method: string = request.method ?? "GET";
  const url: URL = new URL(request.url ?? "/", `http://${HOST}`);
  const pathname: string = url.pathname;
  const parts: string[] = pathname.split("/").filter(Boolean);
  guard(request, method, pathname, allowedHosts);

  if (parts[0] !== "api") {
    if (method !== "GET") {
      throw new HttpError(405, "Method not allowed");
    }
    serveStatic(response, pathname, files);
    return;
  }

  for (const candidate of routes) {
    const params: string[] | null = candidate.method === method ? matched(candidate.pattern, pathname, parts) : null;
    if (params !== null) {
      await candidate.handler({ request, response, url }, ...params);
      return;
    }
  }
  throw new HttpError(404, "Not found");
}

// The server's request handler. The page and the API answer only on the port's
// own addresses.
export function requestListener(
  routes: readonly Route[],
  port: number,
): (request: IncomingMessage, response: ServerResponse) => void {
  const allowedHosts: ReadonlySet<string> = new Set<string>([
    `${HOST}:${port}`,
    `localhost:${port}`,
  ]);
  const files: ReadonlySet<string> = pageFiles();
  return (request: IncomingMessage, response: ServerResponse): void => {
    // Every answer, a CSV download or an error included, says not to guess its type.
    response.setHeader("X-Content-Type-Options", "nosniff");
    route(routes, allowedHosts, files, request, response).catch((error: unknown): void => {
      const status: number = error instanceof HttpError ? error.status : 500;
      const message: string = error instanceof Error ? error.message : String(error);
      if (status === 500) {
        sayError(error);
      }
      if (response.headersSent) {
        response.end();
        return;
      }
      // A body not read to its end, as after a slow upload, is not waited for: the
      // connection closes once the answer is sent.
      if (!request.complete) {
        response.setHeader("Connection", "close");
      }
      sendJson(
        response,
        status,
        {
          error: message,
          ...(error instanceof HttpError ? error.extra : {}),
        },
        error instanceof HttpError ? error.headers : {},
      );
    });
  };
}
