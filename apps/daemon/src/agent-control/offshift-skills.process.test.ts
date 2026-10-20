import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { McpScope } from "@ace/protocol";
import { z } from "zod";
import { builtinGuides, builtinSkillsDirectory, prepareBuiltinSkills } from "@ace/plugins";
import {
  agentControlToolkit,
  CredentialRegistry,
  guideToolkit,
  nodeScheduler,
  ToolRegistry,
} from "@ace/mcp-server";

test("Offshift reaches no provider as a native skill and loads only through its own guide", async () => {
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
  const threads = z
    .object({ tools: z.array(z.string()) })
    .parse((await read("ace-threads")).structuredContent);
  expect(threads.tools).not.toContain("offshift");
  expect(await read("offshift")).toMatchObject({
    structuredContent: { topic: "offshift", tools: ["offshift"] },
  });
  expect(await readdir(builtinSkillsDirectory())).not.toContain("offshift");
  for (const provider of ["claude", "codex"] as const) {
    const sessionRoot = join(root, provider);
    const session = await prepareBuiltinSkills(provider, sessionRoot);
    try {
      const skills = await readdir(join(sessionRoot, "generated/plugins/ace-builtins/skills"));
      expect(skills).toContain("plan-and-delegate");
      expect(skills).not.toContain("offshift");
    } finally {
      await session.close();
    }
  }
});
