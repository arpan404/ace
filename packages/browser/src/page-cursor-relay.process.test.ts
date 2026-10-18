import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserService } from "./index.ts";
import { chromeDesktop } from "./relay-chrome-test-support.ts";
import { executablePath, ref } from "./test-support.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).toReversed()) await close();
}, 60_000);

it.skipIf(!executablePath)(
  "on the desktop's native view the agent's cursor is drawn in the page and comes back after a renderer restart",
  async () => {
    if (!executablePath) return;
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(`<!doctype html><title>Native</title><body>
        <button onclick="window.clicked=true">Press me</button></body>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    const home = await mkdtemp(join(tmpdir(), "ace-cursor-relay-"));
    const desktop = await chromeDesktop(executablePath);
    const service = new BrowserService({
      dataDir: home,
      executablePath,
      backendPreference: () => "embedded",
      agentCursor: { glideMs: 0 },
      collaboration: { quietMs: 1_500, maxWaitMs: 10_000, inUseMs: 60_000, followAfterMs: 30_000 },
    });
    desktop.attach(service.registerEmbedded(desktop.transport));
    closers.push(async () => {
      await service.close();
      await desktop.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    });
    await service.open({ threadId: "thread", workspaceId: "workspace" });
    expect(service.state("thread").backend).toBe("embedded");
    const agent = { kind: "agent" as const, agentId: "helper" };
    const person = { kind: "human" as const, connectionId: "person" };
    await service.execute(
      "thread",
      { action: "navigate", url: `http://127.0.0.1:${address.port}/` },
      agent,
    );
    const snapshot = await service.execute("thread", { action: "snapshot" }, agent);
    await service.execute("thread", { action: "click", ref: ref(snapshot, "Press me") }, agent);
    const drawn = () =>
      service.execute(
        "thread",
        { action: "evaluate", expression: "document.querySelector('ace-agent-cursor') !== null" },
        person,
      );
    expect(
      await service.execute("thread", { action: "evaluate", expression: "window.clicked" }, person),
    ).toBe(true);
    expect(await drawn()).toBe(true);
    await desktop.crashAndRestart();
    await vi.waitFor(async () => expect(await drawn()).toBe(true), { timeout: 15_000 });
  },
  90_000,
);
