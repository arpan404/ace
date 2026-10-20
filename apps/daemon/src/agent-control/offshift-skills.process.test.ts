import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { McpScope } from "@ace/protocol";
import { builtinGuides, prepareBuiltinSkills } from "@ace/plugins";
import {
  agentControlToolkit,
  CredentialRegistry,
  guideToolkit,
  nodeScheduler,
  ToolRegistry,
} from "@ace/mcp-server";

test("providers receive the shipped Offshift workflow as a native skill, and the threads guide reveals its tool", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-offshift-skills-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const guides = await builtinGuides();
  const registry = new ToolRegistry({ scheduler: nodeScheduler });
  agentControlToolkit({
    async execute() {
      throw new Error("Reading a guide must not execute workflow operations");
    },
  }).register(registry);
  guideToolkit(guides).register(registry);
  const credentials = new CredentialRegistry(() => "a".repeat(64));
  onTestFinished(() => credentials.close());
  const lease = credentials.issue(
    McpScope.parse({
      sessionId: "skills",
      threadId: "thread",
      agentId: "root",
      capabilities: ["thread_control"],
    }),
    new AbortController().signal,
  );
  const read = (topic: string) =>
    registry.call("guide", { topic }, lease.principal, new AbortController().signal);
  expect(await read("ace-threads")).toMatchObject({
    structuredContent: { topic: "ace-threads", tools: expect.arrayContaining(["offshift"]) },
  });
  expect(await read("offshift")).toMatchObject({
    structuredContent: {
      topic: "offshift",
      guide: expect.stringContaining("call `guide` with topic `ace-threads`"),
    },
  });
  const guide = guides.find((entry) => entry.name === "offshift");
  if (!guide) throw new Error("Shipped Offshift guide missing");
  for (const provider of ["claude", "codex"] as const) {
    const sessionRoot = join(root, provider);
    const session = await prepareBuiltinSkills(provider, sessionRoot);
    try {
      const skill = await readFile(
        join(sessionRoot, "generated/plugins/ace-builtins/skills/offshift/SKILL.md"),
        "utf8",
      );
      expect(skill).toContain(guide.body);
      if (provider === "claude")
        expect(session.directories).toEqual([join(sessionRoot, "generated/plugins/ace-builtins")]);
      else expect(session.args.join(" ")).toContain("ace-builtins@ace");
    } finally {
      await session.close();
    }
  }
});
