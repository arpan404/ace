import { afterEach, expect, test, vi } from "vitest";
import { WorkspaceId } from "@ace/protocol";
import { cleanups, world } from "./worker-test-support.ts";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

test("an open Skills tab receives completed discovery through the shared worker", async () => {
  const { daemon, tab } = world();
  daemon.createThread({
    id: "skills-thread",
    workspaceId: "project",
    provider: "claude",
    title: "Skills",
  });
  daemon.seedServices({ extensionCatalogs: { claude: [] } });
  const remote = tab();
  await remote.start();
  await vi.waitFor(() => expect(remote.state).toBe("ready"));
  const heard: string[] = [];
  remote.onMessage((message) => {
    if (message.type === "catalog.changed" && message.requestId === "skills")
      heard.push(...message.entries.map((entry) => entry.name));
  });
  await remote.request(
    {
      type: "catalog.list",
      workspace: { workspaceId: WorkspaceId.parse("project"), provider: "claude" },
      subscribe: true,
    },
    { requestId: "skills" },
  );
  daemon.seedServices({
    extensionCatalogs: {
      claude: [
        {
          id: "tdd",
          name: "tdd",
          kind: "skill",
          description: "Test first",
          source: { provider: "claude", scope: "global" },
          invocation: { type: "skill", name: "tdd", path: "/fixture/tdd/SKILL.md" },
        },
      ],
    },
  });
  await vi.waitFor(() => expect(heard).toContain("tdd"));
});
