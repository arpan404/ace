import { appendFileSync, readFileSync } from "node:fs";
import { plugin } from "bun";

/**
 * Records, in ACE_IDLE_IMPORT_LOG, every provider session and heavy package the daemon loads.
 * Bun's resolve hook never sees package imports, so this watches loads: a hook for exactly the
 * forbidden files logs each one and loads its source as written. Any such load already fails
 * the guard, so how it then loads can't hide a violation. Bun applies a preload to the main
 * isolate only (worker threads take no hooks from outside), so this watches the main isolate.
 */
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
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const watched = new RegExp(
  [
    `/node_modules/(?:${forbidden.map(escape).join("|")})/.*\\.[cm]?[jt]s$`,
    ...sessions.map((path) => `${escape(path)}$`),
  ].join("|"),
);
const output = process.env.ACE_IDLE_IMPORT_LOG;

/** What the file is: the session sources are TypeScript, the packages JavaScript. */
const loaderOf = (path: string) => (/\.[cm]?ts$/.test(path) ? "ts" : "js");

if (output)
  plugin({
    name: "idle-imports",
    setup(build) {
      build.onLoad({ filter: watched }, ({ path }) => {
        const session = sessions.find((file) => path.endsWith(file));
        const name = forbidden.find((name) => path.includes(`/node_modules/${name}/`));
        appendFileSync(output, `${session ?? name}: ${path}\n`);
        return { contents: readFileSync(path, "utf8"), loader: loaderOf(path) };
      });
    },
  });
