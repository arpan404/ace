/*
 * Manual check on a real Windows desktop: drives Notepad, Calculator, File Explorer, Settings
 * and Edge through the agent tools (screen_apps, screen_state, screen_act) with a Windows
 * helper built from native/screen-helper-windows, prints what an agent would read, and saves the screenshots.
 *
 *   node packages/screen/bench/computer-real-apps.ts <helper.exe> <output dir>
 *
 * File Explorer's window is closed through the tools; the caller stops the other apps it
 * started. It spends no provider quota.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CredentialRegistry, ToolRegistry } from "@ace/mcp-server";
import { McpScope } from "@ace/protocol";
import { ComputerClient, computerToolkit } from "../src/index.ts";
import { ComputerState } from "../src/computer/wire.ts";

const [helperArg, outArg] = process.argv.slice(2);
if (!helperArg || !outArg)
  throw new Error("usage: computer-real-apps.ts <helper.exe> <output dir>");
const helper = helperArg;
const out = outArg;
mkdirSync(out, { recursive: true });
let next = 0;
const client = new ComputerClient({
  helper: async () => helper,
  nextId: () => `m${++next}`,
  helperArgs: ["--data-dir", join(out, "data")],
});
const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
computerToolkit(client, { platform: "windows" }).register(registry);
const credentials = new CredentialRegistry(() => "c".repeat(64));
const lease = credentials.issue(
  McpScope.parse({ sessionId: "s", threadId: "t", agentId: "root", capabilities: ["screen"] }),
  new AbortController().signal,
);
let shots = 0;
async function tool(name: string, args: Record<string, unknown>) {
  const started = Date.now();
  const result = await registry.call(name, args, lease.principal, new AbortController().signal);
  const text = result.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
  for (const part of result.content)
    if (part.type === "image")
      writeFileSync(
        join(out, `${++shots}-${String(args["app"]).replace(/\W+/g, "_")}.jpg`),
        Buffer.from(part.data, "base64"),
      );
  console.log(
    `\n### ${name} ${JSON.stringify(args)} (${Date.now() - started} ms)${result.isError ? " ERROR" : ""}`,
  );
  console.log(text.length > 2500 ? `${text.slice(0, 2500)}\n…` : text);
  return { text, isError: !!result.isError };
}
async function raw(app: string) {
  return ComputerState.parse(await client.request("state", { app }));
}
const find = (state: ComputerState, test: (n: ComputerState["nodes"][number]) => boolean) =>
  state.nodes.find(test)?.id;
const foreground = () =>
  execFileSync("powershell", [
    "-NoProfile",
    "-Command",
    `Add-Type 'using System;using System.Runtime.InteropServices;public static class F{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);}';$p=0;[void][F]::GetWindowThreadProcessId([F]::GetForegroundWindow(),[ref]$p);(Get-Process -Id $p).ProcessName`,
  ])
    .toString()
    .trim();

try {
  console.log(`foreground at start: ${foreground()}`);
  await tool("screen_apps", {});
  await tool("screen_apps", { query: "calc" });

  // Notepad: launched in the background, typed into by id, read back.
  await tool("screen_state", { app: "Notepad" });
  const notepad = await raw("Notepad");
  const editor = find(notepad, (n) => n.role === "text area" || n.role === "document");
  if (editor)
    await tool("screen_act", {
      app: "Notepad",
      actions: [
        { type: "type", id: editor, text: "Typed by ace in the background.\nSecond line." },
      ],
      screenshot: true,
    });
  console.log(`foreground after Notepad: ${foreground()}`);

  // Calculator: buttons pressed by id in the background.
  await tool("screen_state", { app: "Calculator", screenshot: true });
  const calc = await raw("Calculator");
  const button = (name: string) => find(calc, (n) => n.role === "button" && n.name === name);
  const keys = ["Seven", "Plus", "Eight", "Equals"].map(button);
  if (keys.every((id) => id !== undefined))
    await tool("screen_act", {
      app: "Calculator",
      actions: keys.map((id) => ({ type: "click", id })),
      screenshot: true,
    });
  console.log(`foreground after Calculator: ${foreground()}`);
  // Refusal: a shortcut with no menu command in a background window.
  await tool("screen_act", { app: "Calculator", actions: [{ type: "key", key: "ctrl+shift+k" }] });

  await tool("screen_state", { app: "File Explorer", screenshot: true });
  await tool("screen_state", { app: "Settings", screenshot: true });
  await tool("screen_state", { app: "Microsoft Edge", screenshot: true, outline: false });

  // Refusals before anything launches.
  await tool("screen_state", { app: "cmd.exe" });
  await tool("screen_state", { app: "powershell" });

  // activate, then foreground-only input.
  await tool("screen_act", {
    app: "Calculator",
    actions: [{ type: "activate" }, { type: "key", key: "Escape" }, { type: "key", key: "9" }],
    screenshot: true,
  });
  console.log(`foreground after activate: ${foreground()}`);
  await tool("screen_act", {
    app: "File Explorer",
    actions: [{ type: "window", op: "close" }],
    observe: false,
  });
} finally {
  client.close();
  credentials.close();
}
