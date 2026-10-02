import { z } from "zod";
import type { DiscoveryApi } from "./discovery.ts";

export interface CodexMcpStatusPort {
  request(
    method: "mcpServerStatus/list",
    params: { limit: number; cursor?: string },
    signal: AbortSignal,
  ): Promise<unknown>;
}
const codexPage = z.object({
  data: z.array(z.object({ name: z.string().max(256) }).passthrough()).max(100),
  nextCursor: z.string().max(4096).nullable().optional(),
});
export function codexDiscoveryApi(port: CodexMcpStatusPort): DiscoveryApi {
  return {
    async read(signal) {
      const data: z.output<typeof codexPage>["data"] = [];
      const visited = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 8; page++) {
        signal.throwIfAborted();
        const result = codexPage.parse(
          await port.request(
            "mcpServerStatus/list",
            { limit: 100, ...(cursor === undefined ? {} : { cursor }) },
            signal,
          ),
        );
        if (data.length + result.data.length > 512)
          throw new Error("Discovery server capacity reached");
        data.push(...result.data);
        if (!result.nextCursor) return { data };
        if (visited.has(result.nextCursor)) throw new Error("Repeated discovery cursor");
        visited.add(result.nextCursor);
        cursor = result.nextCursor;
      }
      throw new Error("Discovery page capacity reached");
    },
  };
}
function noop(): void {}
export function claudeDiscoveryApi(query: { mcpServerStatus(): Promise<unknown> }): DiscoveryApi {
  return {
    async read(signal) {
      signal.throwIfAborted();
      // The SDK status read has no abort parameter; abandon it promptly without launching another.
      let remove: () => void = noop;
      const stopped = new Promise<never>((_, reject) => {
        const abort = () => reject(new Error("Discovery cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        remove = () => signal.removeEventListener("abort", abort);
      });
      try {
        return await Promise.race([query.mcpServerStatus(), stopped]);
      } finally {
        remove();
      }
    },
  };
}
export function openCodeDiscoveryApi(options: {
  url: string;
  directory: string;
  fetch: typeof fetch;
}): DiscoveryApi {
  const base = new URL(z.url().parse(options.url));
  if (base.username || base.password || !["http:", "https:"].includes(base.protocol))
    throw new Error("Invalid provider endpoint");
  const endpoint = new URL("/mcp", base);
  endpoint.searchParams.set("directory", options.directory);
  return {
    async read(signal) {
      signal.throwIfAborted();
      const response = await options.fetch(endpoint, { method: "GET", signal });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error("MCP discovery request failed");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      let text = "";
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 512 * 1024) throw new Error("Discovery response capacity reached");
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
        signal.throwIfAborted();
        const value: unknown = JSON.parse(text);
        return z.record(z.string(), z.unknown()).parse(value);
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    },
  };
}
