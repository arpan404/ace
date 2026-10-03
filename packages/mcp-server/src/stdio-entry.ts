import { z } from "zod";
import { runStdioBridge } from "./stdio-bridge.ts";
const environment = z
  .object({
    ACE_MCP_BRIDGE_URL: z.url().refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "http:" &&
        url.hostname === "127.0.0.1" &&
        !!url.port &&
        url.pathname === "/mcp" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    }),
    ACE_MCP_BRIDGE_BEARER: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .parse(process.env);
const lifetime = new AbortController();
process.once("SIGTERM", () => lifetime.abort());
process.once("SIGINT", () => lifetime.abort());
try {
  await runStdioBridge({
    connection: { url: environment.ACE_MCP_BRIDGE_URL, bearer: environment.ACE_MCP_BRIDGE_BEARER },
    input: process.stdin,
    output: process.stdout,
    signal: lifetime.signal,
  });
} catch {
  process.exitCode = 1;
}
