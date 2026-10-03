import { z } from "zod";
import { describe, expect, it } from "vitest";
import { CredentialRegistry, ToolRegistry, nodeScheduler } from "@ace/mcp-server";
import { McpScope } from "@ace/protocol";
import { browserToolkit } from "./index.ts";
import { executablePath, fixture, ref } from "./test-support.ts";

const content = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
});
function parsed(result: unknown): unknown {
  const text = content.parse(result).content[0]?.text;
  if (!text) throw new Error("Missing browser result");
  return JSON.parse(text);
}
describe.skipIf(!executablePath)("authorized agent browser MCP", () => {
  it("edits the caller's browser by semantic ref and respects human takeover", async () => {
    const f = await fixture();
    const registry = new ToolRegistry({ scheduler: nodeScheduler });
    browserToolkit(f.service).register(registry);
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
      registry.call(`ace_browser_${name}`, args, lease.principal, new AbortController().signal);
    try {
      expect(await call("navigate", { url: f.url })).not.toHaveProperty("isError", true);
      const snapshot = parsed(await call("snapshot"));
      const nameRef = ref(snapshot, "Name");
      expect(await call("type", { ref: nameRef, text: "MCP input" })).not.toHaveProperty(
        "isError",
        true,
      );
      expect(await call("click", { ref: ref(snapshot, "Save") })).not.toHaveProperty(
        "isError",
        true,
      );
      expect(await f.evaluate("document.getElementById('result').textContent")).toBe("MCP input");
      const image = z
        .object({
          content: z.array(
            z.object({
              type: z.literal("image"),
              mimeType: z.literal("image/jpeg"),
              data: z.string(),
            }),
          ),
        })
        .parse(await call("screenshot"));
      const screenshot = image.content[0];
      if (!screenshot) throw new Error("Missing screenshot content");
      expect(Buffer.from(screenshot.data, "base64").subarray(0, 2)).toEqual(
        Buffer.from([255, 216]),
      );
      f.service.takeover("thread", "human");
      expect(await call("type", { ref: nameRef, text: "must not type" })).toHaveProperty(
        "isError",
        true,
      );
      expect(
        await f.service.execute(
          "thread",
          { action: "evaluate", expression: "document.querySelector('input').value" },
          { kind: "human", connectionId: "human" },
        ),
      ).toBe("MCP input");
    } finally {
      credentials.close();
    }
  }, 60_000);

  it("denies missing capability, cross-thread arguments and navigation without origin approval", async () => {
    const f = await fixture();
    const registry = new ToolRegistry({ scheduler: nodeScheduler });
    browserToolkit(f.service).register(registry);
    let counter = 0;
    const credentials = new CredentialRegistry(() => (++counter).toString(16).padStart(64, "0"));
    const scope = McpScope.parse({
      sessionId: "provider",
      threadId: "thread",
      agentId: "root",
      capabilities: [],
    });
    const denied = credentials.issue(scope, new AbortController().signal);
    const granted = credentials.issue(
      { ...scope, capabilities: ["browser"] },
      new AbortController().signal,
    );
    const signal = new AbortController().signal;
    try {
      expect(registry.list(denied.principal)).toEqual([]);
      expect(
        await registry.call("ace_browser_navigate", { url: f.url }, denied.principal, signal),
      ).toHaveProperty("isError", true);
      expect(f.service.state("thread").url).toBe("about:blank");
      expect(
        await registry.call(
          "ace_browser_navigate",
          { url: f.url, threadId: "another" },
          granted.principal,
          signal,
        ),
      ).toHaveProperty("isError", true);
      expect(
        await registry.call(
          "ace_browser_navigate",
          { url: "file:///etc/passwd" },
          granted.principal,
          signal,
        ),
      ).toHaveProperty("isError", true);
      expect(f.service.state("thread").url).toBe("about:blank");
    } finally {
      credentials.close();
    }
  }, 60_000);
});

it.skipIf(!executablePath)(
  "drops queued agent browser input when its MCP session ends",
  async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<boolean>();
    const f = await fixture({
      evaluatePolicy: () => {
        started.resolve();
        return release.promise;
      },
    });
    await f.navigate();
    const registry = new ToolRegistry({ scheduler: nodeScheduler });
    browserToolkit(f.service).register(registry);
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
    const blocked = f.execute({ action: "evaluate", expression: "document.title" });
    await started.promise;
    const queued = registry.call(
      "ace_browser_navigate",
      { url: `${f.url}/data` },
      lease.principal,
      new AbortController().signal,
    );
    lifetime.abort();
    release.resolve(true);
    await blocked;
    expect(await queued).toHaveProperty("isError", true);
    await f.execute({ action: "snapshot" });
    expect(f.service.state("thread").url).toBe(`${f.url}/`);
    credentials.close();
  },
  60_000,
);
