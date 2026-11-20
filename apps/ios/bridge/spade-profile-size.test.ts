import { native } from "./test-host.ts";
import { expect, test } from "vitest";
import { parseSpadeAgentValue } from "@ace/ui-core/spade-chat";
import { PatchPump } from "./patch-pump.ts";
import { spadeProfile } from "./spade-profile.ts";

/*
 * A bot that keeps a great deal: its profile still travels in one of the pump's frames, so an
 * approval or a reply's words put just after it reach the phone in the next frame at the latest,
 * never behind a long run of fragments (ADR 0074).
 */

const many = <T>(count: number, make: (index: number) => T) =>
  Array.from({ length: count }, (_, index) => make(index));
const long = (index: number) => `${index} ${"a long line the bot kept ".repeat(30)}`;

/** Spade's answers for a bot with hundreds of everything, each line long. */
function huge(path: string): string {
  if (path.endsWith("/routines"))
    return JSON.stringify({
      routines: many(200, (index) => ({
        id: `r${index}`,
        name: long(index),
        instruction: "Do it",
        trigger: { kind: "schedule", schedule: "daily at 9:00" },
        words: long(index),
        time_zone: "UTC",
        paused: false,
      })),
    });
  if (path.endsWith("/notes"))
    return JSON.stringify({
      notes: many(500, (index) => ({ id: `n${index}`, text: long(index), scope: "agent" })),
    });
  if (path.endsWith("/knowledge"))
    return JSON.stringify({
      entries: many(300, (index) => ({ id: `k${index}`, agent: "writer", title: long(index) })),
    });
  if (path.includes("/workspace"))
    return JSON.stringify({
      path: "",
      entries: many(1000, (index) => ({ name: long(index), path: `f${index}`, kind: "file" })),
    });
  if (path === "/v1/skills")
    return JSON.stringify({
      skills: many(300, (index) => ({
        id: `s${index}`,
        name: long(index),
        origin: "spade",
        written_by: ["writer"],
      })),
    });
  if (path.endsWith("/services"))
    return JSON.stringify({
      services: many(100, (index) => ({ id: `v${index}`, name: long(index), state: "running" })),
    });
  return "{}";
}

test("a bot with a huge library still lets a waiting approval through in the next frame", async () => {
  const agent = parseSpadeAgentValue({
    id: "writer",
    name: "Writer",
    kind: "bot",
    task: "Draft",
    conversation: "c-writer",
  });
  if (!agent) throw new Error("no agent");
  const profile = await spadeProfile(agent, "Studio", async (path) => huge(path), 0);
  // Every list shows a few and counts the rest.
  expect(profile.library.notes).toMatchObject({ more: 488 });
  expect(profile.library.files).toMatchObject({ more: 995 });

  expect(await frameOfApproval(profile)).toBeLessThanOrEqual(1);
});

/** Sends the profile through the pump, then an approval: the frame the approval arrived in. */
async function frameOfApproval(profile: unknown): Promise<number> {
  native.frames.length = 0;
  const emitted: string[] = [];
  const pump = new PatchPump();
  native.ack = (accepted) => pump.ack(accepted);
  const { aceHost } = globalThis;
  const emit = aceHost.emit;
  aceHost.emit = (frame) => {
    emitted.push(frame);
    emit(frame);
  };
  try {
    pump.put("service:profile", () => ({ type: "service.reply", id: "profile", value: profile }));
    pump.put("spade:row:ask", () => ({ type: "spade.row", key: "ask", row: { kind: "ask" } }));
    for (let wait = 0; wait < 100; wait++) {
      if (native.frames.some((patch) => patch.type === "spade.row")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } finally {
    aceHost.emit = emit;
  }

  return emitted.findIndex((frame) => frame.includes('"spade.row"'));
}

test("a profile of long emoji notes and a long emoji task still fits one frame in UTF-8", async () => {
  const agent = parseSpadeAgentValue({
    id: "spade",
    name: "Spade",
    kind: "main",
    // As long as Spade allows: 4,000 code points, 16,000 bytes.
    task: "😀".repeat(4_000),
    conversation: "c-spade",
  });
  if (!agent) throw new Error("no agent");
  const notes = JSON.stringify({
    notes: many(24, (index) => ({ id: `n${index}`, text: "🎉".repeat(500) })),
  });
  const read = async (path: string) => (path.endsWith("notes") ? notes : "{}");

  const profile = await spadeProfile(agent, "Studio", read, 0);

  const reply = JSON.stringify({ type: "service.reply", id: "profile", ok: true, value: profile });
  expect(Buffer.byteLength(reply, "utf8")).toBeLessThanOrEqual(32_768);
  // What didn't fit is counted, not lost from sight.
  const kept = [profile.library.about, profile.library.notes].flatMap((part) =>
    part && "items" in part ? [part.items.length + part.more] : [],
  );
  expect(kept).toEqual([24, 24]);
  expect(await frameOfApproval(profile)).toBeLessThanOrEqual(1);
});
