import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fetchMedia, type MediaFetchOptions } from "./media-fetch.ts";

/*
 * Test support: GitHub's media host played by a local HTTP server. `handle` answers each request;
 * `fetch` fetches what GitHub named from it, keeping the URL's path and query. Never contacts
 * GitHub.
 */

export const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(600, 7),
]);

export async function localMediaHost(
  handle: (request: IncomingMessage, response: ServerResponse, url: URL) => void,
  cleanups: (() => Promise<void>)[],
) {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    handle(request, response, new URL(request.url ?? "/", "http://local"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    requests: () => requests,
    fetch(url: string, temporary: string, options: Partial<MediaFetchOptions> = {}) {
      const parsed = new URL(url);
      return fetchMedia(`http://127.0.0.1:${port}${parsed.pathname}${parsed.search}`, temporary, {
        maxBytes: 1024 * 1024,
        forgeHost: "github.com",
        allowed: () => true,
        hop: () => true,
        ...options,
      });
    },
  };
}

/** A host serving `files` by path; a signed URL works only while its token is `current()`. */
export function signedFiles(
  files: Record<string, { body: Buffer; type: string }>,
  current: () => string,
) {
  return (_request: IncomingMessage, response: ServerResponse, url: URL) => {
    const token = url.searchParams.get("jwt");
    if (token) {
      const payload = Buffer.from(token.split(".")[1] ?? "", "base64url").toString();
      if (!payload.includes(`"token":"${current()}"`)) {
        response.writeHead(403).end("Request has expired");
        return;
      }
    }
    const file = files[url.pathname];
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": file.type }).end(file.body);
  };
}
