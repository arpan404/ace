import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AgentId, ThreadId } from "@ace/protocol";
import { builtinGuides, builtinSkills } from "@ace/plugins";
import { guideTopics } from "@ace/mcp-server";
import type { ProviderAdapter, ProviderSession, SessionContext } from "@ace/engine-api";
import { withDaemonMcp, withShippedSkills } from "./services/provider-mcp.ts";
import { setup, cleanups } from "./browser-mcp-test-support.ts";

/** A provider that records the session context ace hands it, and does nothing else. */
function recording(provider: ProviderAdapter["provider"], backend?: "cursor-sdk") {
  const opened: SessionContext[] = [];
  const session: ProviderSession = {
    nativeSessionId: "recorded",
    send: async () => {},
    interrupt: async () => {},
    resolve: async () => {},
    stopTask: async () => {},
    close: async () => {},
  };
  const adapter: ProviderAdapter = {
    provider,
    ...(backend ? { backend } : {}),
    capabilities: () => ({}) as never,
    createTranslator: () => ({ translate: () => [], tick: () => [] }),
    async openSession(ctx) {
      opened.push(ctx);
      return session;
    },
  };
  return { adapter, opened };
}

it("OpenCode, Pi and Cursor sessions start with ace's skills in a directory they can discover", async () => {
  const f = await setup("codex");
  const daemon = { store: f.store, services: {}, id: () => "skills-session" };
  const opencode = recording("opencode");
  const pi = recording("pi");
  const cursor = recording("cursor", "cursor-sdk");
  const sessions = [
    {
      provider: "opencode",
      opened: opencode.opened,
      adapter: withDaemonMcp(daemon, opencode.adapter),
    },
    { provider: "pi", opened: pi.opened, adapter: withDaemonMcp(daemon, pi.adapter) },
    { provider: "cursor", opened: cursor.opened, adapter: withShippedSkills(cursor.adapter) },
  ];
  const shipped = await builtinGuides();
  const [bundle] = await builtinSkills();
  const native = new Set(bundle?.manifest.skills.map((skill) => skill.name));
  for (const { provider, adapter, opened } of sessions) {
    const lease = f.mcp.openSession(
      {
        sessionId: provider,
        threadId: f.thread.id,
        agentId: AgentId.parse("root"),
        capabilities: [],
      },
      new AbortController().signal,
    );
    const session = await adapter.openSession({
      threadId: f.thread.id,
      cwd: f.home,
      signal: new AbortController().signal,
      aceMcp: { url: f.mcp.url, bearer: lease.bearer, end: lease.end },
      onFrame() {},
      onExit() {},
    });
    cleanups.push(() => session.close("shutdown"));
    const [directory] = opened[0]?.builtinSkills?.directories ?? [];
    if (!directory) throw new Error(`${provider} received no skills directory`);
    // Each skill sits at <directory>/<name>/SKILL.md, the layout all three providers scan.
    // Guide-only topics such as offshift load on request, never as a native skill.
    await expect(readFile(join(directory, "offshift", "SKILL.md"))).rejects.toThrow();
    for (const { name, description } of shipped.filter((guide) => native.has(guide.name))) {
      const text = await readFile(join(directory, name, "SKILL.md"), "utf8");
      expect(text, `${provider} ${name}`).toContain(`name: ${name}`);
      expect(text).toContain(description);
    }
    for (const topic of guideTopics)
      expect(
        shipped.map((guide) => guide.name),
        provider,
      ).toContain(topic);
  }
});

it("a Pi session opened without any ace MCP scope still starts with ace's skills", async () => {
  const f = await setup("codex");
  const pi = recording("pi");
  // No daemon MCP service and no lease: Pi's `--skill` skills don't depend on ace's MCP.
  const adapter = withDaemonMcp({ store: f.store, services: {}, id: () => "no-mcp" }, pi.adapter);
  const session = await adapter.openSession({
    threadId: ThreadId.parse("pi-without-mcp"),
    cwd: f.home,
    signal: new AbortController().signal,
    onFrame() {},
    onExit() {},
  });
  cleanups.push(() => session.close("shutdown"));
  const [directory] = pi.opened[0]?.builtinSkills?.directories ?? [];
  if (!directory) throw new Error("Pi received no skills directory");
  for (const topic of guideTopics)
    expect(await readFile(join(directory, topic, "SKILL.md"), "utf8")).toContain(`name: ${topic}`);
});
