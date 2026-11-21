import { routeConsoleToStderr } from "@ace/provider-kit/console-guard";

// Stdout is the MCP JSON-RPC stream, and Bun's console writes there directly. The MCP client the
// bridge loads logs through console on some paths, so console goes to stderr before any
// dependency loads: static imports would evaluate ahead of this call.
routeConsoleToStderr();
const { z } = await import("zod");
const { runStdioBridge } = await import("./stdio-bridge.ts");
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
    ACE_MCP_BRIDGE_TOOLS: z.enum(["all", "core", "static"]).catch("static"),
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
    listing: environment.ACE_MCP_BRIDGE_TOOLS,
  });
} catch {
  process.exitCode = 1;
}
