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
  "@agentclientprotocol/sdk",
  "@modelcontextprotocol/client",
  "@modelcontextprotocol/server",
  "@modelcontextprotocol/node",
];
const output = process.env.ACE_IDLE_IMPORT_LOG;
if (output) {
  registerHooks({
    load(url, context, nextLoad) {
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
