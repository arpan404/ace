import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import { ThreadId } from "@ace/protocol";
import type { Frame } from "@ace/engine-api";
import { createOpenCodeAdapter, type ServerOptions } from "../index.ts";
import { harness } from "../replay.ts";
const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const owners: ReturnType<typeof createOpenCodeAdapter>[] = [];
function options() {
  return { discovery: { overrides: { opencode: cli, claude: cli, codex: cli, cursor: cli } } };
}
export async function setup(extra: ServerOptions = {}) {
  let origin = "";
  let authorization = "";
  const network = extra.runtime?.fetch ?? fetch;
  const adapter = createOpenCodeAdapter({
    ...options(),
    ...extra,
    runtime: {
      ...extra.runtime,
      fetch: (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        origin = url.origin;
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return network(input, init);
      },
    },
  });
  owners.push(adapter);
  const frames: Frame[] = [];
  const projection = harness();
  const renderedText: string[] = [];
  const waiters = new Set<{ predicate(frame: Frame): boolean; resolve(frame: Frame): void }>();
  const exits: unknown[] = [];
  const controller = new AbortController();
  const onFrame = (frame: Frame) => {
    frames.push(frame);

    for (const w of waiters)
      if (w.predicate(frame)) {
        waiters.delete(w);
        w.resolve(frame);
      }
  };
  const wait = (predicate: (frame: Frame) => boolean) =>
    new Promise<Frame>((resolve) => {
      const old = frames.find(predicate);
      if (old) resolve(old);
      else waiters.add({ predicate, resolve });
    });
  const otherProjection = harness();
  const open = (cwd: string, resume?: string, rootKey = "root") =>
    adapter.openSession({
      rootKey,
      threadId: ThreadId.parse(`thread_${cwd}`),
      cwd,
      model: "provider/model",
      onFrame: (frame) => {
        const target = cwd === "/one" ? projection : otherProjection;
        target.feed(frame);
        for (const item of Object.values(target.view.items))
          if (item.type === "message")
            for (const part of item.parts) if (part.type === "text") renderedText.push(part.text);
        onFrame(frame);
      },
      onExit: (exit) => exits.push(exit),
      signal: controller.signal,
      ...(resume ? { resume: { nativeSessionId: resume } } : {}),
    });
  const control = async (path: string, body?: unknown): Promise<unknown> => {
    const url = new URL(path, origin);
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    return response.json();
  };
  const session = await open("/one");
  const publish = (type: string, properties: unknown, directory = "/one") =>
    control("/test/events", [{ directory, payload: { type, properties } }]);
  return {
    adapter,
    projection,
    renderedText,
    session,
    frames,
    exits,
    controller,
    wait,
    open,
    control,
    publish,
  };
}
afterEach(async () => {
  for (const adapter of owners.splice(0)) await adapter.close();
});
