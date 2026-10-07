import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";

/** Observe actual evaluation in every isolate, including CommonJS and dynamic imports. */
const forbidden = [
  "sharp",
  "@cursor/sdk",
  "playwright",
  "playwright-core",
  "puppeteer",
  "puppeteer-core",
  "chrome-remote-interface",
  "@anthropic-ai/claude-agent-sdk",
  "@opencode-ai/sdk",
  "@opencode/client",
  "tar",
  "tar-stream",
  "yauzl",
  "@agentclientprotocol/sdk",
  "@modelcontextprotocol/client",
  "@modelcontextprotocol/server",
  "@modelcontextprotocol/node",
];
const sessions = ["claude", "pi", "cursor"].map(
  (provider) => `/packages/adapter-${provider}/src/session.ts`,
);
sessions.push("/packages/adapter-opencode/src/server.ts");
const output = process.env.ACE_IDLE_IMPORT_LOG;
if (output) {
  registerHooks({
    load(url, context, nextLoad) {
      for (const path of sessions)
        if (url.endsWith(path)) appendFileSync(output, `${path}: ${url}\n`);
      for (const name of forbidden) {
        if (url.includes(`/node_modules/${name}/`)) {
          appendFileSync(output, `${name}: ${url}\n`);
          break;
        }
      }
      return nextLoad(url, context);
    },
  });
}
