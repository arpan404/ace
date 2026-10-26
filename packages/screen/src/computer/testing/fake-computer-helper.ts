/*
 * A stand-in for `ace-screen-helper --computer` in tests: answers the JSON-lines protocol from
 * a small scripted world, one request at a time with `cancel` answered at once, and appends
 * every op it receives to FAKE_LOG.
 *   FAKE_CRASH_ONCE=<file>  exit on the first state request, then answer normally
 *   FAKE_HANG_ONCE=<file>   never answer the first act request (cancel is ignored)
 *   FAKE_LOG_SESSION=1      log the WAYLAND_DISPLAY it was started with, before any op
 *   FAKE_LOG_ARGS=1         log the arguments it was started with, before any op
 * Apps with scripted trouble: Stuck (never answers state or act, ignores cancel), Frozen (its
 * outline comes back partial, not responding), Huge (its outline is enormous).
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const env = process.env;
const log = (line: string) => env["FAKE_LOG"] && appendFileSync(env["FAKE_LOG"], `${line}\n`);
const once = (marker: string | undefined) => {
  if (!marker || existsSync(marker)) return false;
  writeFileSync(marker, "1");
  return true;
};

interface App {
  bundleId: string;
  name: string;
}
const apps: Record<string, App> = {
  calculator: { bundleId: "com.apple.calculator", name: "Calculator" },
  terminal: { bundleId: "com.apple.Terminal", name: "Terminal" },
  textedit: { bundleId: "com.apple.TextEdit", name: "TextEdit" },
  stuck: { bundleId: "com.example.stuck", name: "Stuck" },
  frozen: { bundleId: "com.example.frozen", name: "Frozen" },
  huge: { bundleId: "com.example.huge", name: "Huge" },
  ace: { bundleId: "dev.ace.app", name: "ace" },
  ghostty: { bundleId: "com.MitchellH.Ghostty", name: "Ghostty" },
  // Linux identities: desktop-file ids, else the executable name.
  "text editor": { bundleId: "org.gnome.TextEditor", name: "Text Editor" },
  ptyxis: { bundleId: "org.gnome.Ptyxis", name: "Ptyxis" },
  keepassxc: { bundleId: "org.keepassxc.KeePassXC", name: "KeePassXC" },
  konsole: { bundleId: "org.kde.konsole", name: "Konsole" },
  "secret prompter": { bundleId: "org.kde.secretprompter", name: "Secret Prompter" },
  kcalc: { bundleId: "org.kde.kcalc", name: "KCalc" },
  kitty: { bundleId: "kitty", name: "kitty" },
  "polkit agent": { bundleId: "polkit-gnome-authentication-agent-1", name: "Polkit Agent" },
  "ace-desktop": { bundleId: "ace-desktop", name: "ace" },
  "ace-desktop-bin": { bundleId: "ace-desktop-bin", name: "ace" },
};
const find = (query: unknown) =>
  apps[String(query ?? "").toLowerCase()] ??
  Object.values(apps).find((app) => app.bundleId.toLowerCase() === String(query).toLowerCase());

let display = "0";

const state = (app: App, screenshot: boolean) => ({
  app: { name: app.name, bundleId: app.bundleId, pid: 41, active: false },
  windows: [{ index: 1, title: app.name, onScreen: false, current: true }],
  window: { title: app.name, width: 674, height: 408, onScreen: false },
  nodes: [
    { id: 1, depth: 0, role: "standard window", name: app.name },
    { id: 6, depth: 1, role: "text", name: display },
    { id: 23, depth: 1, role: "button", name: "7" },
    ...(app.name === "Huge"
      ? [{ id: 24, depth: 1, role: "text", name: "x".repeat(256 * 1024) }]
      : []),
  ],
  truncated: false,
  menuBar: [app.name, "Edit"],
  ...(app.name === "Frozen" ? { notResponding: true, elapsedMs: 1200 } : {}),
  ...(screenshot
    ? { screenshot: { jpeg: Buffer.from("jpeg").toString("base64"), width: 674, height: 408 } }
    : {}),
});

const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const cancelled = new Set<string>();

interface Request {
  id: string;
  op: string;
  [key: string]: unknown;
}
interface Action {
  type: string;
  text?: string;
  ms?: number;
  when?: { text?: string; gone?: boolean };
}

async function act(request: Request, app: App): Promise<unknown> {
  const actions = (request["actions"] ?? []) as Action[];
  const done: string[] = [];
  for (const [index, action] of actions.entries()) {
    if (cancelled.has(request.id))
      return { done, error: { index, code: "cancelled", message: "Cancelled." } };
    if (action.when?.text) {
      const present = JSON.stringify(state(app, false).nodes).includes(action.when.text);
      if (present === !!action.when.gone) {
        done.push(`skipped ${action.type}: condition not met`);
        continue;
      }
    }
    if (action.type === "menu")
      return {
        done,
        error: {
          index,
          code: "menu_not_found",
          message: 'No "Fiel" in the menu bar. Items: Calculator, Edit.',
        },
        state: state(app, false),
      };
    if (action.type === "wait") {
      const until = Date.now() + (action.ms ?? 0);
      while (Date.now() < until && !cancelled.has(request.id)) await sleep(20);
      if (cancelled.has(request.id))
        return { done, error: { index, code: "cancelled", message: "Cancelled." } };
      done.push(`waited ${action.ms ?? 0} ms`);
      continue;
    }
    if (action.type === "type") display = "408";
    done.push(
      action.type === "type"
        ? `typed ${action.text?.length ?? 0} characters`
        : `did ${action.type}`,
    );
  }
  return {
    done,
    ...(request["observe"] === false ? {} : { state: state(app, request["screenshot"] === true) }),
  };
}

/** Answers one request; undefined means it never replies. */
async function answer(request: Request): Promise<unknown> {
  const app = find(request["app"]);
  const missing = {
    id: request.id,
    ok: false,
    error: {
      code: "app_not_found",
      message: `No installed app matches "${String(request["app"])}".`,
    },
  };
  switch (request.op) {
    case "hello":
      return { id: request.id, ok: true, result: { version: 2, capabilities: ["cancel"] } };
    case "apps":
      return {
        id: request.id,
        ok: true,
        result: {
          apps: Object.values(apps).map(({ bundleId, name }) => ({
            bundleId,
            name,
            running: true,
          })),
        },
      };
    case "resolve":
      return app ? { id: request.id, ok: true, result: { ...app, running: true } } : missing;
    case "state":
      if (!app) return missing;
      if (once(env["FAKE_CRASH_ONCE"])) process.exit(3);
      if (app.name === "Stuck") return undefined;
      return { id: request.id, ok: true, result: state(app, request["screenshot"] === true) };
    case "act":
      if (!app) return missing;
      if (app.name === "Stuck" || once(env["FAKE_HANG_ONCE"])) return undefined;
      return { id: request.id, ok: true, result: await act(request, app) };
    default:
      return { id: request.id, ok: false, error: { code: "bad_request", message: "Unknown op." } };
  }
}

if (env["FAKE_LOG_ARGS"]) log(`args ${process.argv.slice(2).join(" ")}`);
if (env["FAKE_LOG_SESSION"]) log(`session WAYLAND_DISPLAY=${env["WAYLAND_DISPLAY"] ?? ""}`);
let queue = Promise.resolve();
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line) as Request;
  if (request.op === "cancel") {
    log(`cancel`);
    cancelled.add(String(request["target"]));
    return send({ id: request.id, ok: true, result: { cancelled: true } });
  }
  log(`${request.op} ${typeof request["app"] === "string" ? request["app"] : ""}`.trim());
  // One request at a time, like the helper; one that never answers holds the queue.
  queue = queue.then(async () => {
    const reply = await answer(request);
    if (reply === undefined) return new Promise<void>(() => {});
    send(reply);
  });
});
