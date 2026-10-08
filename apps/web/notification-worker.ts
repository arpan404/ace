import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/** A root-scoped module worker, built apart from the page and served at the same URL in dev. */
export function notificationWorker(): Plugin {
  let building = false;
  return {
    configResolved(config) {
      building = config.command === "build";
    },
    name: "ace:notification-worker",
    buildStart() {
      if (!building) return;
      this.emitFile({
        type: "chunk",
        id: fileURLToPath(new URL("./src/notification-worker.ts", import.meta.url)),
        fileName: "notification-worker.js",
      });
    },
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        if (request.url === "/notification-worker.js") request.url = "/src/notification-worker.ts";
        next();
      });
    },
  };
}
