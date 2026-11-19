/*
 * End to end through the daemon's real ComputerClient and computer-use tools: the tools an
 * agent calls (screen_apps, screen_state, screen_act) against the Linux helper binary.
 * Usage (inside a Wayland desktop session, after `bun install`; run-client-e2e.sh makes one):
 *   node native/screen-helper-linux/tests/computer/client-e2e.ts <helper-binary>
 */
// Each package's public entry (its package.json "." export); this script lives outside the
// workspaces, so their names do not resolve from here.
import { CredentialRegistry, ToolRegistry } from "../../../../packages/mcp-server/src/index.ts";
import { McpScope } from "../../../../packages/protocol/src/index.ts";
import { ComputerClient, computerToolkit } from "../../../../packages/screen/src/index.ts";

const binary = process.argv[2];
if (!binary) throw new Error("Pass the helper binary.");

let next = 0;
const client = new ComputerClient({ helper: async () => binary, nextId: () => `e${++next}` });
const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
computerToolkit(client).register(registry);
const credentials = new CredentialRegistry(() => "a".repeat(64));
const lease = credentials.issue(
  McpScope.parse({ sessionId: "s", threadId: "thread", agentId: "root", capabilities: ["screen"] }),
  new AbortController().signal,
);

async function call(name: string, args: Record<string, unknown>) {
  const result = await registry.call(name, args, lease.principal, new AbortController().signal);
  const text = result.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
  const images = result.content.filter((part) => part.type === "image").length;
  return { error: result.isError === true, text, images };
}

const failures: string[] = [];
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failures.push(name);
    console.log(detail);
  }
}

try {
  const apps = await call("screen_apps", {});
  check(
    "screen_apps lists the running Linux apps",
    apps.text.includes("org.gnome.Calculator"),
    apps.text,
  );

  const look = await call("screen_state", { app: "Calculator" });
  check("screen_state shows the outline", !look.error && look.text.includes("button 7"), look.text);
  const id = (name: string) =>
    look.text.match(
      new RegExp(`(\\d+) button ${name.replace(/[+*]/g, "\\$&")}(?:,|\\n|$)`, "m"),
    )?.[1];
  const keys = ["7", "×", "6", "="].map(id);
  check("the outline names Calculator's buttons", keys.every(Boolean), look.text);

  const acted = await call("screen_act", {
    app: "Calculator",
    actions: [
      ...keys.map((key) => ({ type: "click", id: Number(key) })),
      { type: "wait_for", text: "42", timeout_ms: 3000 },
    ],
  });
  check(
    "screen_act presses buttons, waits for the result and shows only what changed",
    !acted.error &&
      acted.text.includes("Changes since your last look") &&
      acted.text.includes("42"),
    acted.text,
  );

  const guarded = await call("screen_act", {
    app: "Calculator",
    actions: [
      { type: "if", text: "no such thing" },
      { type: "click", id: Number(keys[0]) },
      { type: "wait_for", text: "42" },
    ],
  });
  check("if guards expand to when and skip", guarded.text.includes("skipped click"), guarded.text);

  const raw = await call("screen_act", {
    app: "Calculator",
    actions: [{ type: "key", key: "Escape" }],
  });
  check(
    "a raw key Wayland can't send explains how to proceed",
    raw.text.includes("element ids"),
    raw.text,
  );
} finally {
  client.close();
  credentials.close();
}
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
