import { expect, test } from "vitest";
import { z } from "zod";
import { AgentControlOperation, Item, type McpAttribution } from "@ace/protocol";
import { createAgentControlPort } from "@ace/daemon";
import { setup } from "./test-support.ts";

const Page = z.object({
  items: z.array(z.looseObject({ id: z.string(), type: z.string() })),
  itemsBefore: z.number().nullable(),
  omitted: z
    .array(z.object({ itemId: z.string(), dropped: z.enum(["raw", "item"]), title: z.string() }))
    .optional(),
});

function message(agentId: string, id: string) {
  return Item.parse({
    id,
    agentId,
    type: "message",
    role: "assistant",
    parts: [{ type: "text", text: `answer ${id}` }],
    createdAt: 1,
    complete: true,
  });
}
function shell(agentId: string, id: string, command: string) {
  return Item.parse({
    id,
    agentId,
    type: "tool_call",
    complete: true,
    createdAt: 1,
    call: {
      id,
      agentId,
      kind: "shell",
      title: `Run ${command}`,
      status: "succeeded",
      startedAt: 1,
      detail: { kind: "shell", command },
      raw: [],
    },
  });
}

async function readAll(
  read: (before: number | undefined, limit: number) => Promise<z.infer<typeof Page>>,
  limit: number,
) {
  const seen: string[] = [];
  const omitted: NonNullable<z.infer<typeof Page>["omitted"]> = [];
  let before: number | undefined;
  for (let calls = 0; calls < 40; calls++) {
    const page = await read(before, limit);
    // Each page is oldest first; collect newest first across pages.
    const entries = [
      ...page.items.map((item) => item.id),
      ...(page.omitted ?? []).filter((o) => o.dropped === "item").map((o) => o.itemId),
    ];
    seen.push(...entries.toReversed());
    omitted.push(...(page.omitted ?? []));
    if (page.itemsBefore === null) return { seen, omitted, calls: calls + 1 };
    expect(page.itemsBefore).not.toBe(before);
    before = page.itemsBefore;
  }
  throw new Error("Paging never ended");
}

test("paging a thread back with itemsBefore returns the earlier items and ends cleanly", async () => {
  const h = setup();
  const port = createAgentControlPort(h.store, h.service);
  const agent: McpAttribution = await h.parent("full-access");
  const read = async (before: number | undefined, limit: number) => {
    const result = await port.execute(
      agent,
      AgentControlOperation.parse({
        op: "thread.read",
        threadId: agent.threadId,
        limit,
        ...(before ? { before } : {}),
      }),
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    return Page.parse(result.data);
  };
  const before = await readAll(read, 50);
  // A shell call whose command alone is larger than any agent page, among ordinary answers.
  const appended = [
    ...Array.from({ length: 12 }, (_, n) => message(agent.agentId, `older-${n}`)),
    shell(agent.agentId, "huge-heredoc", `cat > notes.md <<'EOF'\n${"é".repeat(120_000)}\nEOF`),
    ...Array.from({ length: 12 }, (_, n) => message(agent.agentId, `newer-${n}`)),
  ];
  h.store.appendEvents(
    agent.threadId,
    appended.map((item) => ({ type: "item.created" as const, item })),
    h.clock.now(),
  );

  for (const limit of [5, 25, 40]) {
    const { seen, omitted } = await readAll(read, limit);
    // Every item appears once, newest first, followed by what the thread held before.
    expect(seen).toEqual([...appended.map((item) => item.id).toReversed(), ...before.seen]);
    expect(omitted).toEqual([
      expect.objectContaining({
        itemId: "huge-heredoc",
        dropped: "item",
        title: expect.stringMatching(/^Run cat > notes\.md/),
      }),
    ]);
  }
});

test("a tool call too large only for its raw provider payload is shown without it", async () => {
  const h = setup();
  const port = createAgentControlPort(h.store, h.service);
  const agent: McpAttribution = await h.parent("full-access");
  const call = shell(agent.agentId, "noisy-ls", "ls");
  if (call.type !== "tool_call") throw new Error("Expected a tool call");
  call.call.raw = [{ type: "commandExecution", data: { aggregatedOutput: "x".repeat(60_000) } }];
  h.store.appendEvents(agent.threadId, [{ type: "item.created", item: call }], h.clock.now());
  const result = await port.execute(
    agent,
    AgentControlOperation.parse({ op: "thread.read", threadId: agent.threadId, limit: 1 }),
    new AbortController().signal,
  );
  const page = Page.parse(result.data);
  expect(page.items).toEqual([
    expect.objectContaining({
      id: "noisy-ls",
      call: expect.objectContaining({ title: "Run ls", raw: [] }),
    }),
  ]);
  expect(page.omitted).toEqual([expect.objectContaining({ itemId: "noisy-ls", dropped: "raw" })]);
  expect(page.itemsBefore).not.toBeNull();
});
