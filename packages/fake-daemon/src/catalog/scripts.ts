/*
 * What a project's scripts print when Run starts them in a terminal, so a script's tab shows
 * realistic output in fake mode rather than a bare prompt. Long-running scripts (dev servers,
 * soaks) print their banner and keep running; one-shot scripts print a result and return to
 * the prompt (`done`).
 */

const lines = (...text: string[]) => text.map((line) => `${line}\r\n`).join("");
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const green = (text: string) => `\x1b[32m${text}\x1b[0m`;

export interface ScriptOutput {
  text: string;
  /** The script finished and the shell is back at its prompt. */
  done: boolean;
}

export function scriptOutput(name: string): ScriptOutput {
  switch (name) {
    case "dev:relay":
      return {
        text: lines(
          dim("$ node --watch apps/server/src/relay.ts"),
          "relay listening on ws://127.0.0.1:8787",
          dim("watching apps/server/src for changes"),
        ),
        done: false,
      };
    case "dev":
      return {
        text: lines(
          "",
          `  ${green("VITE v8.3.2")}  ready in 412 ms`,
          "",
          "  ➜  Local:   http://localhost:5173/",
          dim("  ➜  press h + enter to show help"),
        ),
        done: false,
      };
    case "soak":
      return {
        text: lines(
          "soak relay listening on ws://127.0.0.1:8790",
          "client web-1 connected · resume seq 1182",
          "client ios-2 connected · resume seq 0 · cold start",
        ),
        done: false,
      };
    case "test":
      return {
        text: lines(
          dim("vitest run"),
          ` ${green("✓")} apps/server/src/replay.test.ts (3 tests) 19 ms`,
          ` ${green("✓")} apps/web/src/relay/outbox.test.ts (5 tests) 31 ms`,
          ` ${green("8 pass")} · 0 fail · 2 files  \x1b[1m604ms\x1b[0m`,
        ),
        done: true,
      };
    case "typecheck":
      return { text: lines(dim("tsc -b"), "Found 0 errors."), done: true };
    case "build":
      return {
        text: lines(
          dim("vite build"),
          "✓ 412 modules transformed.",
          "dist/index.html                 0.62 kB │ gzip:  0.38 kB",
          "dist/assets/index-4f1c2a.js   268.40 kB │ gzip: 86.11 kB",
          green("✓ built in 2.14s"),
        ),
        done: true,
      };
    default:
      return { text: "", done: true };
  }
}
