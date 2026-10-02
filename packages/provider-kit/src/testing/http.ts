import { once } from "node:events";
import { createServer, type RequestListener, type Server } from "node:http";
const servers: Server[] = [];
const controllers: AbortController[] = [];
export async function server(listener: RequestListener) {
  const http = createServer(listener);
  servers.push(http);
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("No test address");
  return `http://127.0.0.1:${address.port}/global/event`;
}
export function controller() {
  const result = new AbortController();
  controllers.push(result);
  return result;
}
export async function cleanupServers() {
  controllers.splice(0).forEach((c) => c.abort());
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve, reject) => {
          s.closeAllConnections();
          s.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
}
