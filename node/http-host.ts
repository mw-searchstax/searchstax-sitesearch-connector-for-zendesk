import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";

import { createApiHandler } from "../worker/api/router.ts";
import type { ApplicationService } from "../worker/api/types.ts";

const LOOPBACK = "127.0.0.1";
const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

export interface LoopbackHost {
  origin: string;
  close(): Promise<void>;
}

function send(
  response: ServerResponse,
  status: number,
  body: Uint8Array | string,
  contentType: string,
  head = false,
) {
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
  });
  response.end(head ? undefined : body);
}

async function sendWebResponse(
  target: ServerResponse,
  source: Response,
  head: boolean,
) {
  const headers: Record<string, string> = {};
  source.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const body = Buffer.from(await source.arrayBuffer());
  target.writeHead(source.status, headers);
  target.end(head ? undefined : body);
}

function requestHeaders(request: IncomingMessage) {
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2)
    headers.append(request.rawHeaders[index]!, request.rawHeaders[index + 1]!);
  return headers;
}

function traversalAttempt(rawUrl: string) {
  const pathname = rawUrl.split("?", 1)[0]!;
  return pathname
    .split("/")
    .some((segment) => decodeURIComponent(segment) === "..");
}

export interface HttpHostOptions {
  listenAddress?: "127.0.0.1" | "0.0.0.0";
  operatorOrigin?: string;
  ready?: () => Promise<boolean>;
}

export async function startLoopbackHost(
  service: ApplicationService,
  assetRoot: string,
  port = 0,
  options: HttpHostOptions = {},
): Promise<LoopbackHost> {
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new RangeError("The HTTP port was invalid.");
  const root = resolve(assetRoot);
  const api = createApiHandler(service);
  const server = createServer((request, response) => {
    void (async () => {
      const origin =
        options.operatorOrigin ??
        `http://${LOOPBACK}:${request.socket.localPort}`;
      if (
        options.ready &&
        ["/healthz", "/readyz"].includes(request.url ?? "")
      ) {
        if (!["GET", "HEAD"].includes(request.method ?? "")) {
          send(response, 405, "Method not allowed.", "text/plain");
          return;
        }
        const ready =
          request.url === "/healthz" ||
          (await options.ready().catch(() => false));
        response.setHeader("cache-control", "no-store");
        send(
          response,
          ready ? 200 : 503,
          ready ? "ok\n" : "not ready\n",
          "text/plain",
          request.method === "HEAD",
        );
        return;
      }
      if (
        options.operatorOrigin &&
        request.headers.host !== new URL(origin).host
      ) {
        send(response, 403, "Host rejected.", "text/plain");
        return;
      }
      const rawUrl = request.url ?? "/";
      let url: URL;
      try {
        if (traversalAttempt(rawUrl)) {
          send(response, 404, "Not found.", "text/plain; charset=utf-8");
          return;
        }
        url = new URL(rawUrl, origin);
        if (options.operatorOrigin && url.origin !== origin) {
          send(response, 403, "Origin rejected.", "text/plain");
          return;
        }
      } catch {
        send(response, 400, "Bad request.", "text/plain; charset=utf-8");
        return;
      }

      const head = request.method === "HEAD";
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        const init: RequestInit & { duplex?: "half" } = {
          method: request.method,
          headers: requestHeaders(request),
        };
        if (!head && request.method !== "GET") {
          init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
          init.duplex = "half";
        }
        await sendWebResponse(
          response,
          await api(new Request(url, init)),
          head,
        );
        return;
      }

      if (request.method !== "GET" && !head) {
        send(response, 405, "Method not allowed.", "text/plain; charset=utf-8");
        return;
      }

      const assetPath = url.pathname.startsWith("/assets/")
        ? resolve(root, `.${url.pathname}`)
        : resolve(root, "index.html");
      if (
        url.pathname.startsWith("/assets/") &&
        !assetPath.startsWith(root + sep)
      ) {
        send(response, 404, "Not found.", "text/plain; charset=utf-8");
        return;
      }
      try {
        const body = await readFile(assetPath);
        send(
          response,
          200,
          body,
          CONTENT_TYPES[extname(assetPath)] ?? "application/octet-stream",
          head,
        );
      } catch {
        send(response, 404, "Not found.", "text/plain; charset=utf-8");
      }
    })().catch(() => {
      if (!response.headersSent)
        send(response, 500, "Request failed.", "text/plain; charset=utf-8");
      else response.destroy();
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, options.listenAddress ?? LOOPBACK, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("The loopback listener address was unavailable.");
  }

  return {
    origin:
      options.operatorOrigin ?? `http://${address.address}:${address.port}`,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      }),
  };
}
