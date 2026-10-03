// Benchmark I/O boundary only. No installed CLI or provider inference.
import { fileURLToPath } from "node:url";
import { createOpenCodeAdapter } from "../src/index.ts";
import type { Frame } from "@ace/engine-api";
const cli = fileURLToPath(new URL("../src/testing/cli-v2.mjs", import.meta.url));
export function boundary(observe: (frame: Frame) => void) {
  let origin = "",
    authorization = "",
    pages = 0;
  const adapter = createOpenCodeAdapter({
    runtime: {
      discover: async () => ({
        opencode: { installed: true, path: cli, version: "2.0.22", auth: "unknown", loginHint: "" },
        claude: { installed: false, auth: "unknown", loginHint: "" },
        codex: { installed: false, auth: "unknown", loginHint: "" },
        cursor: { installed: false, auth: "unknown", loginHint: "" },
      }),
      fetch: (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        origin = url.origin;
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        if (url.pathname === "/api/session" && (init?.method ?? "GET") === "GET") pages++;
        return fetch(input, init);
      },
    },
  });
  return {
    adapter,
    observe,
    pages: () => pages,
    async control(path: string, body: unknown) {
      const response = await fetch(new URL(path, origin), {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      await response.body?.cancel();
    },
  };
}
