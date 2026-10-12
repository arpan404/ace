import { Item, type ToolDetail, type ToolResult } from "@ace/protocol";
import { expect, it } from "vitest";
import { toolSurface, toolSurfaces } from "./index.ts";

function call(
  id: string,
  detail: ToolDetail,
  options: { agent?: string | undefined; title?: string; result?: ToolResult } = {},
) {
  return Item.parse({
    id,
    agentId: options.agent ?? "root",
    type: "tool_call",
    createdAt: 1,
    complete: true,
    call: {
      id,
      agentId: options.agent ?? "root",
      kind: detail.kind,
      title: options.title ?? id,
      status: "succeeded",
      startedAt: 1,
      detail,
      raw: [],
      ...(options.result ? { result: options.result } : {}),
    },
  });
}
const browse = (id: string, url?: string, agent?: string) =>
  call(
    id,
    { kind: "mcp", server: "ace", tool: "ace_browser_open", arguments: url ? { url } : {} },
    { agent },
  );

it("names the site a browser step opened by its origin, never its path or credentials", () => {
  const item = browse("open", "https://user:secret@Docs.Python.org:8443/3/library?q=1#x");
  expect(item.type === "tool_call" && toolSurface(item.call)).toEqual({
    kind: "browser",
    icon: { kind: "site", origin: "https://docs.python.org:8443" },
  });
});

it("carries an agent's site to its later browser steps that name no URL", () => {
  const surfaces = toolSurfaces([
    browse("open", "https://github.com/arpan404/ace"),
    call("read", { kind: "file.read", path: "a.ts" }),
    browse("click"),
    browse("other-agent", undefined, "child"),
  ]);
  expect(surfaces.get("click")?.icon).toEqual({ kind: "site", origin: "https://github.com" });
  expect(surfaces.has("read")).toBe(false);
  // Another agent's browser is not on that site.
  expect(surfaces.get("other-agent")).toEqual({ kind: "browser" });
});

it("names the app a computer-use step acted on from the daemon's result target", () => {
  const item = call(
    "type",
    { kind: "mcp", server: "ace", tool: "screen_type", arguments: { text: "hi" } },
    {
      result: {
        isError: false,
        content: [],
        durationMs: 3,
        target: { bundleId: "com.apple.dt.Xcode", displayName: "Xcode" },
      },
    },
  );
  expect(item.type === "tool_call" && toolSurface(item.call)).toEqual({
    kind: "computer",
    icon: { kind: "app", identity: "com.apple.dt.Xcode", name: "Xcode" },
  });
});

it("gives fetched pages their site and leaves ordinary tools without a surface", () => {
  const fetched = call("fetch", { kind: "web.fetch", url: "https://vercel.com/docs" });
  const shell = call("shell", { kind: "shell", command: "ls" });
  const local = call("local", { kind: "web.fetch", url: "file:///etc/passwd" });
  expect(fetched.type === "tool_call" && toolSurface(fetched.call)?.icon).toEqual({
    kind: "site",
    origin: "https://vercel.com",
  });
  expect(shell.type === "tool_call" && toolSurface(shell.call)).toBeUndefined();
  expect(local.type === "tool_call" && toolSurface(local.call)).toBeUndefined();
});
