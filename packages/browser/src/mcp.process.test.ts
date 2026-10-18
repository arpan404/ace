import { z } from "zod";
import { describe, expect, it } from "vitest";
import { CredentialRegistry, ToolRegistry, nodeScheduler } from "@ace/mcp-server";
import { McpScope } from "@ace/protocol";
import { browserToolkit } from "./index.ts";
import { executablePath, fixture, textRef, toolPort } from "./test-support.ts";

const Text = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
});
const textOf = (result: unknown) =>
  Text.parse(result)
    .content.map((part) => part.text)
    .join("\n");
const jsonOf = (result: unknown): unknown => JSON.parse(textOf(result));

function agent(port: Parameters<typeof browserToolkit>[0]) {
  const registry = new ToolRegistry({ scheduler: nodeScheduler });
  browserToolkit(port).register(registry);
  const credentials = new CredentialRegistry(() => "a".repeat(64));
  const lease = credentials.issue(
    McpScope.parse({
      sessionId: "provider",
      threadId: "thread",
      agentId: "root",
      capabilities: ["browser"],
    }),
    new AbortController().signal,
  );
  const call = (name: string, args: unknown = {}) =>
    registry.call(name, args, lease.principal, new AbortController().signal);
  return { registry, lease, call, close: () => credentials.close() };
}

const unused = async () => {
  throw new Error("not called");
};
const never = () => {
  throw new Error("not called");
};
it("reads never prompt and only input, navigation and scripts count as effects", () => {
  const f = agent({
    open: unused,
    tab: unused,
    state: never,
    execute: unused,
    screenshot: unused,
    close: unused,
  });
  try {
    const risk = (name: string, args: unknown) => f.registry.action(name, args)?.riskClass;
    expect(risk("browser_snapshot", {})).toBe("read-only");
    expect(risk("browser_find", { role: "button" })).toBe("read-only");
    expect(risk("browser_logs", {})).toBe("read-only");
    expect(risk("browser_history", {})).toBe("read-only");
    expect(risk("browser_history", { direction: "back" })).toBe("external-effect");
    expect(risk("browser_act", { action: "click", ref: "e1-2" })).toBe("external-effect");
    expect(risk("browser_evaluate", { expression: "1" })).toBe("external-effect");
    expect(risk("browser_tabs", {})).toBe("read-only");
    expect(risk("browser_tabs", { action: "close", tabId: "t" })).toBe("external-effect");
    expect(risk("browser_settings", { action: "extensions" })).toBe("read-only");
    expect(risk("browser_settings", { action: "close" })).toBe("external-effect");
    const listed = f.registry.list(f.lease.principal);
    const open = listed.find((tool) => tool.name === "browser_open");
    expect(open).toMatchObject({
      annotations: { openWorldHint: true, destructiveHint: false },
      _meta: { "anthropic/alwaysLoad": true },
    });
    expect(listed.find((tool) => tool.name === "browser_snapshot")?.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
    });
    expect(listed.filter((tool) => !tool.title)).toEqual([]);
  } finally {
    f.close();
  }
});

it("refuses an act whose fields do not fit its action before touching the page", async () => {
  let touched = false;
  const touch = async () => {
    touched = true;
    throw new Error("touched");
  };
  const f = agent({
    open: touch,
    tab: touch,
    state: never,
    execute: touch,
    screenshot: touch,
    close: touch,
  });
  try {
    const result = jsonOf(await f.call("browser_act", { action: "type", ref: "e1-2", key: "a" }));
    expect(result).toMatchObject({
      code: "invalid_arguments",
      issues: expect.arrayContaining([
        expect.objectContaining({ path: "text" }),
        expect.objectContaining({ path: "key" }),
      ]),
    });
    expect(touched).toBe(false);
  } finally {
    f.close();
  }
});

describe.skipIf(!executablePath)("ace browser tools on real Chromium", () => {
  it("opens a page, reads compact refs and acts on them", async () => {
    const page = await fixture();
    const f = agent(toolPort(page.service));
    try {
      expect(jsonOf(await f.call("browser_open", { url: page.url }))).toMatchObject({
        url: `${page.url}/`,
        controller: "agent",
      });
      const snapshot = textOf(await f.call("browser_snapshot"));
      expect(snapshot).toMatch(/^- textbox "Name" \[ref=e\d+-\d+\]$/m);
      expect(snapshot).not.toMatch(/generic|nodeId|childIds|"ignored"/);
      await f.call("browser_act", {
        action: "type",
        ref: textRef(snapshot, "textbox", "Name"),
        text: "MCP input",
      });
      const clicked = jsonOf(
        await f.call("browser_act", { action: "click", ref: textRef(snapshot, "button", "Save") }),
      );
      expect(clicked).toMatchObject({ ok: true });
      expect(await page.evaluate("document.getElementById('result').textContent")).toBe(
        "MCP input",
      );
      page.service.takeover("thread", "human");
      expect(
        jsonOf(
          await f.call("browser_act", {
            action: "type",
            ref: textRef(snapshot, "textbox", "Name"),
            text: "must not type",
          }),
        ),
      ).toMatchObject({ code: "human_controlled" });
    } finally {
      f.close();
    }
  }, 60_000);

  it("keeps a large page under budget, says it was cut, and narrows by scope or role", async () => {
    const page = await fixture();
    const f = agent(toolPort(page.service));
    try {
      await f.call("browser_open", { url: `${page.url}/big` });
      const full = textOf(await f.call("browser_snapshot", { maxNodes: 2000 }));
      const cut = textOf(await f.call("browser_snapshot", { maxNodes: 50 }));
      expect(cut.split("\n").filter((line) => line.includes("- ")).length).toBeLessThanOrEqual(50);
      expect(cut).toMatch(/\[truncated: 50 of \d+ nodes shown\. Narrow with ref=/);
      // A page this size is about 1,600 lines; the raw AX JSON was over 400 KB.
      expect(Buffer.byteLength(full)).toBeLessThan(48 * 1024);

      const footer = textRef(full, "region", "Footer area");
      const scoped = textOf(await f.call("browser_snapshot", { ref: footer }));
      expect(scoped).toContain('- button "Footer action"');
      expect(scoped).not.toContain("Edit 1");

      const interactive = textOf(
        await f.call("browser_snapshot", { interactiveOnly: true, maxNodes: 2000 }),
      );
      expect(interactive).not.toMatch(/^\s*- text:/m);
      expect(interactive).toMatch(/^- button "Edit 399" \[ref=/m);

      const found = textOf(await f.call("browser_find", { role: "button", name: "edit 39" }));
      expect(found.split("\n")).toHaveLength(11);
      const ref = textRef(found, "button", "Edit 399");
      expect(jsonOf(await f.call("browser_act", { action: "focus", ref }))).toMatchObject({
        ok: true,
      });
      expect(await page.evaluate("document.activeElement.textContent")).toBe("Edit 399");
    } finally {
      f.close();
    }
  }, 60_000);

  it("performs every act kind through one tool", async () => {
    const page = await fixture();
    const f = agent(toolPort(page.service));
    const output = () => page.evaluate("document.getElementById('out').textContent");
    try {
      await f.call("browser_open", { url: `${page.url}/controls` });
      const snap = textOf(await f.call("browser_snapshot"));
      expect(snap).toMatch(/^\s*- heading "Controls" \[level=1\]/m);
      expect(snap).toMatch(/^\s*- listitem "Milk"/m);
      expect(snap).toMatch(/^\s*- textbox "Email" \[ref=[^\]]+\]: ada@example\.com$/m);
      const act = async (args: Record<string, unknown>) =>
        expect(jsonOf(await f.call("browser_act", args))).toMatchObject({ ok: true });
      const ref = (role: string, name: string) => textRef(snap, role, name);

      await act({ action: "click", ref: ref("button", "Go") });
      expect(await output()).toBe("clicked");
      await act({ action: "hover", ref: ref("button", "Hover me") });
      expect(await output()).toBe("hovered");
      await act({ action: "focus", ref: ref("button", "Focus me") });
      expect(await output()).toBe("focused");
      await act({ action: "type", ref: ref("textbox", "Email"), text: "grace@example.com" });
      await act({ action: "press", ref: ref("textbox", "Email"), key: "Enter" });
      expect(await output()).toBe("entered");
      await act({ action: "check", ref: ref("checkbox", "Agree") });
      expect(await page.evaluate("document.querySelector('[aria-label=Agree]').checked")).toBe(
        true,
      );
      await act({ action: "uncheck", ref: ref("checkbox", "Agree") });
      expect(await page.evaluate("document.querySelector('[aria-label=Agree]').checked")).toBe(
        false,
      );
      await act({ action: "select", ref: ref("combobox", "Colour"), values: ["blue"] });
      expect(await page.evaluate("document.querySelector('select').value")).toBe("blue");
      await act({ action: "scroll", y: 600 });
      await page.evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
      expect(await page.evaluate("window.scrollY")).toBeGreaterThan(0);

      const Pending = z.object({
        pending_dialog: z.object({ dialogId: z.string() }),
        hint: z.string(),
      });
      // The click either reports the dialog it opened, or the next read does.
      const clicked = textOf(
        await f.call("browser_act", { action: "click", ref: ref("button", "Confirm") }),
      );
      const pending = Pending.safeParse(JSON.parse(clicked)).success
        ? Pending.parse(JSON.parse(clicked))
        : Pending.parse(jsonOf(await f.call("browser_snapshot")));
      expect(pending.hint).toContain('action:"dialog"');
      await act({ action: "dialog", dialogId: pending.pending_dialog.dialogId, accept: true });
      await expect.poll(output).toBe("true");
    } finally {
      f.close();
    }
  }, 60_000);

  it("an agent works in a tab of its own by tabId, and closing it leaves the first tab", async () => {
    const page = await fixture();
    const f = agent(toolPort(page.service));
    const Tabs = z.object({
      tabs: z.array(
        z.object({
          tabId: z.string(),
          label: z.string().optional(),
          current: z.boolean().optional(),
          openedBy: z.object({ kind: z.string(), agentId: z.string().optional() }).optional(),
        }),
      ),
    });
    try {
      const first = z
        .object({ tabId: z.string() })
        .parse(jsonOf(await f.call("browser_open", { url: page.url }))).tabId;
      const opened = z.object({ tabId: z.string(), label: z.string() }).parse(
        jsonOf(
          await f.call("browser_tabs", {
            action: "open",
            url: `${page.url}/controls`,
            label: "form",
          }),
        ),
      );
      expect(opened).toMatchObject({ label: "form" });
      expect(opened.tabId).not.toBe(first);
      const listed = Tabs.parse(jsonOf(await f.call("browser_tabs")));
      expect(listed.tabs.find((tab) => tab.tabId === opened.tabId)).toMatchObject({
        current: true,
        openedBy: { kind: "agent", agentId: "root" },
      });
      // The first tab, named by id, is read and filled while the new one stays current.
      const snapshot = textOf(await f.call("browser_snapshot", { tabId: first }));
      expect(snapshot).toContain(`[tab=${first}]`);
      expect(
        jsonOf(
          await f.call("browser_act", {
            tabId: first,
            action: "fill_form",
            fields: [{ ref: textRef(snapshot, "textbox", "Name"), value: "filled" }],
          }),
        ),
      ).toMatchObject({ ok: true, tabId: first });
      expect(
        jsonOf(
          await f.call("browser_evaluate", {
            tabId: first,
            expression: "document.querySelector('input').value",
          }),
        ),
      ).toBe("filled");
      // Without tabId, calls land in the agent's current tab: the one it opened.
      expect(textOf(await f.call("browser_snapshot"))).toContain(`[tab=${opened.tabId}]`);
      const printed = z
        .object({ path: z.string() })
        .parse(jsonOf(await f.call("browser_screenshot", { tabId: first, format: "pdf" })));
      expect(printed.path).toMatch(/\.pdf$/);
      expect(
        jsonOf(await f.call("browser_tabs", { action: "close", tabId: opened.tabId })),
      ).toMatchObject({ closed: true, open: 1 });
      expect(page.service.state("thread").tabs?.map((tab) => tab.tabId)).toEqual([first]);
      expect(jsonOf(await f.call("browser_snapshot", { tabId: opened.tabId }))).toMatchObject({
        code: "tab_not_found",
      });
    } finally {
      f.close();
    }
  }, 60_000);

  it("lists history entries, moves through them and reports navigation after an act", async () => {
    const page = await fixture();
    const f = agent(toolPort(page.service));
    try {
      await f.call("browser_open", { url: `${page.url}/controls` });
      const snap = textOf(await f.call("browser_snapshot"));
      const moved = jsonOf(
        await f.call("browser_act", { action: "click", ref: textRef(snap, "link", "Next page") }),
      );
      await f.call("browser_wait_for", { url: `${page.url}/next` });
      expect(moved).toMatchObject({ ok: true });
      const history = z
        .object({
          back: z.boolean(),
          entries: z.array(z.object({ url: z.string(), current: z.boolean().optional() })),
        })
        .parse(jsonOf(await f.call("browser_history")));
      expect(history.back).toBe(true);
      expect(history.entries.map((entry) => entry.url)).toEqual(
        expect.arrayContaining([`${page.url}/controls`, `${page.url}/next`]),
      );
      expect(history.entries.find((entry) => entry.current)?.url).toBe(`${page.url}/next`);
      await f.call("browser_history", { direction: "back" });
      await f.call("browser_wait_for", { url: `${page.url}/controls` });
      expect(jsonOf(await f.call("browser_open"))).toMatchObject({ url: `${page.url}/controls` });
    } finally {
      f.close();
    }
  }, 60_000);

  it("tells the agent which call recovers from a stale ref or a closed browser", async () => {
    const page = await fixture();
    const f = agent(toolPort(page.service));
    try {
      await f.call("browser_open", { url: page.url });
      const ref = textRef(textOf(await f.call("browser_snapshot")), "button", "Save");
      await f.call("browser_open", { url: `${page.url}/next` });
      expect(jsonOf(await f.call("browser_act", { action: "click", ref }))).toMatchObject({
        code: "stale_ref",
        hint: expect.stringContaining("browser_snapshot"),
      });
      await f.call("browser_settings", { action: "close" });
      expect(() => page.service.state("thread")).toThrow("not open");
      // Every tool reopens the page on demand, so a closed browser is never a dead end.
      expect(jsonOf(await f.call("browser_open", { url: page.url }))).toMatchObject({
        url: `${page.url}/`,
      });
    } finally {
      f.close();
    }
  }, 60_000);

  it("drops queued agent navigation when its MCP session ends", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<boolean>();
    const page = await fixture({
      evaluatePolicy: () => {
        started.resolve();
        return release.promise;
      },
    });
    await page.navigate();
    const registry = new ToolRegistry({ scheduler: nodeScheduler });
    browserToolkit(toolPort(page.service)).register(registry);
    const credentials = new CredentialRegistry(() => "a".repeat(64));
    const lifetime = new AbortController();
    const lease = credentials.issue(
      McpScope.parse({
        sessionId: "provider",
        threadId: "thread",
        agentId: "root",
        capabilities: ["browser"],
      }),
      lifetime.signal,
    );
    const blocked = page.execute({ action: "evaluate", expression: "document.title" });
    await started.promise;
    const queued = registry.call(
      "browser_open",
      { url: `${page.url}/data` },
      lease.principal,
      new AbortController().signal,
    );
    lifetime.abort();
    release.resolve(true);
    await blocked;
    expect(await queued).toHaveProperty("isError", true);
    await page.execute({ action: "snapshot" });
    expect(page.service.state("thread").url).toBe(`${page.url}/`);
    credentials.close();
  }, 60_000);
});
