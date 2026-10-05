import { afterEach, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { BrowserService, detectChromium } from "./index.ts";
import { ref, Snapshot } from "./test-support.ts";
const executablePath = await detectChromium();
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
}, 60_000);
async function setup(options: Partial<import("./service-options.ts").BrowserServiceOptions> = {}) {
  const home = await mkdtemp(join(tmpdir(), "ace-parity-"));
  const artifacts: import("@ace/protocol").BrowserArtifact[] = [];
  const server = createServer((req, res) => {
    if (req.url === "/file") {
      res.writeHead(200, {
        "Content-Disposition": "attachment; filename=example.zip",
        "Content-Type": "application/zip",
      });
      res.end("zip-fixture");
      return;
    }
    if (req.url === "/failed") {
      res.destroy();
      return;
    }
    if (req.url === "/slow") {
      res.writeHead(200, {
        "Content-Disposition": "attachment; filename=slow.txt",
        "Content-Type": "text/plain",
      });
      res.write("start".repeat(256));
      const timer = setTimeout(() => res.end("finish"), 2000);
      res.on("close", () => clearTimeout(timer));
      return;
    }
    if (req.url === "/body") {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end('{"token":"secret-value","safe":"body-marker"}');
      return;
    }
    res.setHeader("Content-Type", "text/html");
    if (req.url === "/frame") {
      res.end(
        `<button onclick="this.textContent='Clicked frame'">Frame button</button><input aria-label="Frame input">`,
      );
      return;
    }
    const host = req.headers.host ?? "";
    res.end(`<!doctype html><title>Parity</title><body>
    <input aria-label="Name"><input type="file" aria-label="File"><input type="checkbox" aria-label="Agree">
    <select aria-label="Choice"><option value="a">A</option><option value="b">B</option></select>
    <a href="/other" target="_blank">Popup</a><a href="/file">Download</a><a href="/slow">Slow download</a>
    <button onclick="document.body.dataset.answer=prompt('Question','default')">Prompt</button>
    <button onmouseover="document.body.dataset.hovered=1">Hover</button>
    <div role="button" aria-label="Drag source" draggable="true" ondragstart="event.dataTransfer.setData('text/plain','dragged')" style="width:100px;height:40px">Drag</div>
    <div role="button" aria-label="Drop target" ondragover="event.preventDefault()" ondrop="event.preventDefault();document.body.dataset.dropped=event.dataTransfer.getData('text/plain')" style="width:100px;height:40px">Drop</div>
    <iframe src="/frame" title="same"></iframe><iframe src="http://localhost:${host.split(":")[1]}/frame" title="cross"></iframe>
    <script>fetch('/body');console.warn('console-marker');</script></body>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  const url = `http://127.0.0.1:${address.port}`;
  const service = new BrowserService({
    dataDir: home,
    ...(executablePath ? { executablePath } : {}),
    workspaceRoot: () => home,
    evaluatePolicy: () => true,
    downloadPolicy: () => true,
    onArtifact: (_thread, artifact) => {
      artifacts.push(artifact);
    },
    ...options,
  });
  cleanups.push(async () => {
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  });
  await service.open({ threadId: "thread", workspaceId: "workspace", background: true });
  const execute = (command: unknown) => service.execute("thread", command);
  await execute({ action: "navigate", url });
  return {
    service,
    execute,
    url,
    home,
    artifacts,
    evaluate: (expression: string) => execute({ action: "evaluate", expression }),
  };
}
const tabs = z.object({
  activeTabId: z.string(),
  tabs: z.array(z.object({ tabId: z.string(), url: z.string() })),
});

it.skipIf(!executablePath)(
  "background tabs preserve their own page and enforce thread and daemon caps",
  async () => {
    const f = await setup({ maxTabs: 9 });
    const initial = tabs.parse(await f.execute({ action: "tabs" }));
    await f.execute({
      action: "type",
      ref: ref(await f.execute({ action: "snapshot" }), "Name"),
      text: "first",
    });
    const second = tabs.parse(
      await f.execute({ action: "tabs", operation: "open", url: f.url + "/other" }),
    );
    expect(second.tabs).toHaveLength(2);
    expect(second.activeTabId).not.toBe(initial.activeTabId);
    expect(await f.evaluate("document.querySelector('input').value")).toBe("");
    await f.execute({ action: "tabs", operation: "switch", tabId: initial.activeTabId });
    expect(await f.evaluate("document.querySelector('input').value")).toBe("first");
    await f.execute({
      action: "click",
      ref: ref(await f.execute({ action: "snapshot" }), "Popup"),
    });
    await expect.poll(() => f.service.state("thread").tabs?.length).toBe(3);
    for (let n = 3; n < 8; n++) await f.execute({ action: "tabs", operation: "open" });
    await expect(f.execute({ action: "tabs", operation: "open" })).rejects.toThrow(/tab limit/);
    await f.service.open({ threadId: "second", workspaceId: "workspace", background: true });
    await expect(
      f.service.execute("second", { action: "tabs", operation: "open" }),
    ).rejects.toThrow(/tab limit/);
    await f.execute({ action: "tabs", operation: "close", tabId: second.activeTabId });
    await f.service.execute("second", { action: "tabs", operation: "open" });
  },
);
it.skipIf(!executablePath)(
  "semantic input and same/cross origin frame refs change the intended elements",
  async () => {
    const f = await setup();
    await f.execute({ action: "wait_for", text: "Popup" });
    const snap = await f.execute({ action: "snapshot" });
    const nodes = Snapshot.parse(snap).nodes.filter(
      (node) => node.name === "Frame input" && node.ref,
    );
    expect(nodes).toHaveLength(2);
    for (const node of nodes)
      await f.execute({ action: "type", ref: node.ref, text: "frame-value" });
    expect(
      Snapshot.parse(await f.execute({ action: "snapshot" }))
        .nodes.filter((node) => node.name === "Frame input")
        .map((node) => node.value),
    ).toEqual(["frame-value", "frame-value"]);
    const frameButtons = Snapshot.parse(await f.execute({ action: "snapshot" })).nodes.filter(
      (node) => node.name === "Frame button" && node.role === "button" && node.ref,
    );
    for (const button of frameButtons) await f.execute({ action: "click", ref: button.ref });
    expect(
      Snapshot.parse(await f.execute({ action: "snapshot" })).nodes.filter(
        (node) => node.name === "Clicked frame" && node.role === "button",
      ),
    ).toHaveLength(2);
    const current = await f.execute({ action: "snapshot" });
    await f.execute({ action: "check", ref: ref(current, "Agree") });
    expect(await f.evaluate("document.querySelector('[type=checkbox]').checked")).toBe(true);
    await f.execute({ action: "uncheck", ref: ref(snap, "Agree") });
    expect(await f.evaluate("document.querySelector('[type=checkbox]').checked")).toBe(false);
    await f.execute({ action: "select", ref: ref(snap, "Choice"), values: ["b"] });
    expect(await f.evaluate("document.querySelector('select').value")).toBe("b");
    await f.execute({ action: "hover", ref: ref(snap, "Hover") });
    expect(await f.evaluate("document.body.dataset.hovered")).toBe("1");
    await f.execute({ action: "focus", ref: ref(await f.execute({ action: "snapshot" }), "Name") });
    expect(await f.evaluate("document.activeElement.getAttribute('aria-label')")).toBe("Name");
    await f.execute({
      action: "drag",
      ref: ref(await f.execute({ action: "snapshot" }), "Drag source"),
      toRef: ref(await f.execute({ action: "snapshot" }), "Drop target"),
    });
    expect(await f.evaluate("document.body.dataset.dropped")).toBe("dragged");
    const found = Snapshot.parse(
      await f.execute({ action: "find", role: "button", name: "Clicked frame" }),
    );
    expect(found.nodes.filter((node) => node.ref)).toHaveLength(2);
  },
);
it.skipIf(!executablePath)(
  "dialogs wait for an explicit answer and downloads become flagged artifacts",
  async () => {
    const f = await setup();
    await f.execute({
      action: "click",
      ref: ref(await f.execute({ action: "snapshot" }), "Prompt"),
    });
    await expect.poll(() => f.service.state("thread").pending_dialog?.type).toBe("prompt");
    const dialog = f.service.state("thread").pending_dialog;
    if (!dialog) throw new Error("dialog");
    await f.execute({
      action: "dialog",
      dialogId: dialog.dialogId,
      accept: true,
      promptText: "answered",
    });
    expect(await f.evaluate("document.body.dataset.answer")).toBe("answered");
    await f.execute({
      action: "click",
      ref: ref(await f.execute({ action: "snapshot" }), "Download"),
    });
    await expect.poll(() => f.artifacts.length).toBe(1);
    const artifact = f.artifacts[0];
    if (!artifact) throw new Error("artifact");
    expect(artifact).toMatchObject({
      filename: "example.zip",
      mimeType: "application/zip",
      flags: ["archive"],
      bytes: 11,
    });
    expect(await readFile(artifact.path, "utf8")).toBe("zip-fixture");
  },
);
it.skipIf(!executablePath)(
  "uploads use workspace files and require approval for outside paths",
  async () => {
    const priorArtifacts = new Set<string>();
    const f = await setup({ artifactAllowed: (_thread, path) => priorArtifacts.has(path) });
    await writeFile(join(f.home, "upload.txt"), "upload-content");
    const fileRef = ref(await f.execute({ action: "snapshot" }), "File");
    await f.execute({ action: "upload", ref: fileRef, files: ["upload.txt"] });
    expect(await f.evaluate("document.querySelector('[type=file]').files[0].name")).toBe(
      "upload.txt",
    );
    const outside = await mkdtemp(join(tmpdir(), "ace-outside-"));
    await writeFile(join(outside, "outside.txt"), "outside");
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await expect(
      f.execute({ action: "upload", ref: fileRef, files: [join(outside, "outside.txt")] }),
    ).rejects.toThrow(/denied/);
    await symlink(join(outside, "outside.txt"), join(f.home, "linked.txt"));
    await expect(
      f.execute({ action: "upload", ref: fileRef, files: ["linked.txt"] }),
    ).rejects.toThrow(/denied/);
    priorArtifacts.add(join(outside, "outside.txt"));
    await f.execute({ action: "upload", ref: fileRef, files: [join(outside, "outside.txt")] });
    expect(await f.evaluate("document.querySelector('[type=file]').files[0].name")).toBe(
      "outside.txt",
    );
  },
);
it.skipIf(!executablePath)(
  "read-only evaluation reads DOM but refuses mutation, navigation and network writes",
  async () => {
    const f = await setup();
    expect(
      await f.execute({ action: "evaluate", mode: "read-only", expression: "document.title" }),
    ).toBe("Parity");
    for (const expression of [
      "document.body.textContent='changed'",
      "location.href='/other'",
      "fetch('/body',{method:'POST'})",
    ])
      await expect(
        f.execute({ action: "evaluate", mode: "read-only", expression }),
      ).rejects.toThrow();
    expect(await f.evaluate("document.title")).toBe("Parity");
  },
);
it.skipIf(!executablePath)(
  "private takeover blocks all agent reads and disconnect keeps the thread paused",
  async () => {
    const f = await setup();
    f.service.takeover("thread", "human", "private");
    for (const action of ["snapshot", "screenshot", "logs", "tabs", "record_start"])
      await expect(f.execute({ action })).rejects.toMatchObject({ code: "human_private" });
    await expect(f.service.screenshot("thread")).rejects.toMatchObject({ code: "human_private" });
    f.service.disconnect("human");
    expect(f.service.state("thread").status).toBe("paused");
    await expect(f.execute({ action: "snapshot" })).rejects.toMatchObject({
      code: "human_private",
    });
    f.service.takeover("thread", "reconnected", "private");
    f.service.handback("thread", "reconnected");
    expect(Snapshot.parse(await f.execute({ action: "snapshot" })).nodes.length).toBeGreaterThan(0);
  },
);
it.skipIf(!executablePath)(
  "inspection returns filtered inline entries and redacts a bounded response",
  async () => {
    const f = await setup();
    const Logs = z.object({
      entries: z.array(
        z.object({
          text: z.string(),
          url: z.string().optional(),
          requestId: z.string().optional(),
          status: z.number().optional(),
        }),
      ),
    });
    await expect
      .poll(
        async () =>
          Logs.parse(await f.execute({ action: "logs", kind: "network", status: 201 })).entries
            .length,
      )
      .toBe(1);
    const response = Logs.parse(await f.execute({ action: "logs", url: "/body", status: 201 }))
      .entries[0];
    expect(response?.requestId).toBeTruthy();
    await expect
      .poll(async () => {
        try {
          return z
            .object({ body: z.string() })
            .parse(await f.execute({ action: "network_body", requestId: response?.requestId }))
            .body.includes("body-marker");
        } catch {
          return false;
        }
      })
      .toBe(true);
    const body = z
      .object({ body: z.string() })
      .parse(await f.execute({ action: "network_body", requestId: response?.requestId }));
    expect(body.body).toContain("body-marker");
    expect(body.body).not.toContain("secret-value");
    await expect
      .poll(
        async () =>
          Logs.parse(
            await f.execute({ action: "logs", kind: "network", url: "/frame", status: 200 }),
          ).entries.filter((entry) => entry.url?.startsWith("http://localhost:")).length,
      )
      .toBe(1);
    const crossFrame = Logs.parse(
      await f.execute({ action: "logs", kind: "network", url: "/frame", status: 200 }),
    ).entries.find((entry) => entry.url?.startsWith("http://localhost:"));
    await expect
      .poll(async () => {
        try {
          return z
            .object({ body: z.string() })
            .parse(await f.execute({ action: "network_body", requestId: crossFrame?.requestId }))
            .body.includes("Frame input");
        } catch {
          return false;
        }
      })
      .toBe(true);
    expect(
      z
        .object({ body: z.string() })
        .parse(await f.execute({ action: "network_body", requestId: crossFrame?.requestId })).body,
    ).toContain("Frame input");
    await f.evaluate("fetch('/failed').catch(()=>undefined)");
    await expect
      .poll(
        async () =>
          Logs.parse(
            await f.execute({ action: "logs", kind: "network", level: "failed", url: "/failed" }),
          ).entries.length,
      )
      .toBeGreaterThan(0);
    const original = f.service.state("thread").activeTabId;
    await f.execute({ action: "tabs", operation: "open" });
    await f.execute({ action: "tabs", operation: "close", tabId: original });
    await expect(
      f.execute({ action: "network_body", requestId: response?.requestId }),
    ).rejects.toThrow(/unavailable/);

    expect(
      Logs.parse(await f.execute({ action: "logs", level: "warning" })).entries[0]?.text,
    ).toContain("console-marker");
  },
);

it.skipIf(!executablePath)(
  "private takeover cancels an in-flight download without publishing its bytes",
  async () => {
    const f = await setup();
    await f.execute({
      action: "click",
      ref: ref(await f.execute({ action: "snapshot" }), "Slow download"),
    });
    await expect.poll(() => f.service.state("thread").downloads?.[0]?.state).toBe("pending");
    f.service.takeover("thread", "human", "private");
    await expect.poll(() => f.service.state("thread").downloads?.[0]?.state).toBe("denied");
    expect(f.artifacts).toEqual([]);
    f.service.handback("thread", "human");
    expect(f.service.state("thread").downloads?.[0]?.path).toBeUndefined();
  },
);
it.skipIf(!executablePath)("oversized downloads never publish artifacts", async () => {
  const f = await setup({ maxDownloadBytes: 8 });
  await f.execute({
    action: "click",
    ref: ref(await f.execute({ action: "snapshot" }), "Download"),
  });
  await expect
    .poll(() => f.service.state("thread").downloads?.[0]?.state)
    .toMatch(/failed|too_large/);
  expect(f.artifacts).toEqual([]);
  expect(f.service.state("thread").downloads?.[0]?.path).toBeUndefined();
});
it.skipIf(!executablePath)(
  "agent recording tools publish the existing recording artifact",
  async () => {
    const f = await setup();
    expect(await f.execute({ action: "record_start" })).toEqual({ recording: true });
    const recording = z
      .object({ path: z.string(), mimeType: z.string(), bytes: z.number().positive() })
      .parse(await f.execute({ action: "record_stop" }));
    expect(f.artifacts).toEqual([recording]);
    expect((await readFile(recording.path)).byteLength).toBe(recording.bytes);
  },
);
