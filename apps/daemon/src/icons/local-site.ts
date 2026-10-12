import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

/** A real local web server for icon fetch tests; `routes` maps paths to bodies or redirects. */
export async function localSite(
  routes: Record<string, Buffer | "hang" | { redirect: string } | { html: string }>,
) {
  const seen: { path: string; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((request, response) => {
    seen.push({ path: request.url ?? "", headers: request.headers });
    const route = routes[request.url ?? ""];
    if (route === "hang") return;
    if (!route) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    if (Buffer.isBuffer(route)) {
      response.setHeader("content-type", "image/png");
      response.end(route);
    } else if ("redirect" in route) {
      response.statusCode = 302;
      response.setHeader("location", route.redirect);
      response.end();
    } else {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(route.html);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? (address satisfies AddressInfo).port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    seen,
    /** Only this server counts as the public web. */
    allowed: (host: string, candidate: number) => host === "127.0.0.1" && candidate === port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
