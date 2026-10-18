/*
 * A stand-in for `ace-screen-helper --computer` in tests: answers the JSON-lines protocol from
 * a small scripted world and appends every op it receives to FAKE_LOG.
 *   FAKE_CRASH_ONCE=<file>  exit on the first state request, then answer normally
 *   FAKE_HANG_ONCE=<file>   never answer the first act request
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

const apps: Record<string, { bundleId: string; name: string }> = {
  calculator: { bundleId: "com.apple.calculator", name: "Calculator" },
  terminal: { bundleId: "com.apple.Terminal", name: "Terminal" },
};
let display = "0";

const state = (screenshot: boolean) => ({
  app: { name: "Calculator", bundleId: "com.apple.calculator", pid: 41, active: false },
  windows: [{ index: 1, title: "Calculator", onScreen: false, current: true }],
  window: { title: "Calculator", width: 674, height: 408, onScreen: false },
  nodes: [
    { id: 1, depth: 0, role: "standard window", name: "Calculator" },
    { id: 6, depth: 1, role: "text", name: display },
    { id: 23, depth: 1, role: "button", name: "7" },
  ],
  truncated: false,
  menuBar: ["Calculator", "Edit"],
  ...(screenshot
    ? { screenshot: { jpeg: Buffer.from("jpeg").toString("base64"), width: 674, height: 408 } }
    : {}),
});

const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line) as Record<string, unknown> & { id: string; op: string };
  log(`${request.op} ${typeof request["app"] === "string" ? request["app"] : ""}`.trim());
  const app =
    apps[String(request["app"] ?? "").toLowerCase()] ??
    Object.values(apps).find((entry) => entry.bundleId === request["app"]);
  switch (request.op) {
    case "resolve":
      if (!app)
        return send({
          id: request.id,
          ok: false,
          error: {
            code: "app_not_found",
            message: `No installed app matches "${String(request["app"])}".`,
          },
        });
      return send({ id: request.id, ok: true, result: { ...app, running: true } });
    case "state":
      if (once(env["FAKE_CRASH_ONCE"])) process.exit(3);
      return send({ id: request.id, ok: true, result: state(request["screenshot"] === true) });
    case "act": {
      if (once(env["FAKE_HANG_ONCE"])) return;
      const actions = (request["actions"] ?? []) as { type: string; text?: string }[];
      const done: string[] = [];
      for (const [index, action] of actions.entries()) {
        if (action.type === "menu")
          return send({
            id: request.id,
            ok: true,
            result: {
              done,
              error: {
                index,
                code: "menu_not_found",
                message: 'No "Fiel" in the menu bar. Items: Calculator, Edit.',
              },
              state: state(false),
            },
          });
        if (action.type === "type") display = "408";
        done.push(
          action.type === "type"
            ? `typed ${action.text?.length ?? 0} characters`
            : `did ${action.type}`,
        );
      }
      return send({ id: request.id, ok: true, result: { done, state: state(false) } });
    }
    default:
      return send({
        id: request.id,
        ok: false,
        error: { code: "bad_request", message: "Unknown op." },
      });
  }
});
