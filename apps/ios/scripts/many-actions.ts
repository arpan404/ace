import { FakeDaemon, facts } from "@ace/fake-daemon";
import { z } from "zod";

export function manyActions(daemon: FakeDaemon, id: string): void {
  daemon.createThread({
    id,
    workspaceId: "ace",
    title: "Many approval actions",
    provider: "codex",
    permissionMode: "ask",
  });
  daemon.apply(id, [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.tool("root", "many-tool", {
      kind: "shell",
      title: "Choose an action",
      status: "awaiting_approval",
      detail: { kind: "shell", command: "printf review" },
    }),
    {
      type: "interaction.opened",
      agent: "root",
      interaction: "many-approval",
      item: "many-tool",
      blocking: true,
      request: {
        kind: "approval",
        title: "Choose an action",
        options: Array.from({ length: 300 }, (_, index) => ({
          id: `action-${index}-` + "x".repeat(32768),
          label: `Choice ${index}`,
          kind: "deny",
        })),
      },
    },
  ]);
}

const SnapshotEnvelope = z.object({
  type: z.literal("snapshot"),
  subscriptionId: z.string().min(1),
  seq: z.number().int().nonnegative(),
});

/** Speak the real snapshot.part protocol so the SDK admits the large logical snapshot. */
export function* snapshotFrames(text: string): Generator<string> {
  if (text.length <= 131072) {
    yield text;
    return;
  }
  const parsed = SnapshotEnvelope.safeParse(JSON.parse(text));
  if (!parsed.success) {
    yield text;
    return;
  }
  let index = 0;
  for (let offset = 0; offset < text.length; offset += 131072) {
    const end = Math.min(text.length, offset + 131072);
    yield JSON.stringify({
      type: "snapshot.part",
      subscriptionId: parsed.data.subscriptionId,
      seq: parsed.data.seq,
      index: index++,
      done: end === text.length,
      data: text.slice(offset, end),
    });
  }
}
