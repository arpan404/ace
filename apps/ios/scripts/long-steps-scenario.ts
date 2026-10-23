import { facts, type FakeDaemon } from "@ace/fake-daemon";
import type { Fact } from "@ace/core";

/*
 * A finished thread whose turns each did a lot of work, for timing how fast a settled "Worked
 * for" log, a step's detail, a thought and a thought read in full open: six turns of 80 steps
 * (reads, edits with diffs, commands with output, thoughts between them, the first longer than a
 * row carries) and a short answer each. Each turn has its own native id, so each reads as its own
 * turn. No provider process runs.
 */

const minute = 60_000;
const turns = 6;
const stepsPerTurn = 80;

const diff = (n: number) =>
  [
    `@@ -${n},4 +${n},6 @@`,
    " const lease = leases.get(id);",
    "-return lease;",
    "+if (!lease) return;",
    "+lease.touch(now);",
    "+return lease;",
  ].join("\n");
const output = (n: number) =>
  Array.from(
    { length: 30 },
    (_, line) => `relay/step-${n}.test.ts > keeps cursor ${line} ✓ ${line + 3}ms`,
  ).join("\n");
const answer = (turn: number) =>
  Array.from(
    { length: 2 },
    (_, n) =>
      `### Part ${n + 1}\n\nTurn ${turn + 1} moved \`cursor-${n}\` into the lease so a reconnect resumes there.\n\n- \`relay.ts\` stores it.\n- \`replay.ts\` reads it back.`,
  ).join("\n\n");

function step(turn: number, n: number): Fact[] {
  const id = `t${turn}-s${n}`;
  switch (n % 4) {
    case 0:
      return [
        {
          type: "item.upsert",
          agent: "root",
          item: `${id}-thought`,
          draft: {
            type: "reasoning",
            complete: true,
            text: `Step ${n + 1} needs the lease before replay.\n\n${"The cursor must survive a restart, so it is written with the lease and read back on resume. ".repeat(n === 0 ? 100 : 20)}`,
          },
        },
      ];
    case 1:
      return [
        facts.tool("root", id, {
          kind: "file.read",
          title: `Read relay-${n}.ts`,
          detail: { kind: "file.read", path: `packages/relay/src/relay-${n}.ts` },
        }),
        facts.toolDone("root", id),
      ];
    case 2:
      return [
        facts.tool("root", id, {
          kind: "file.edit",
          title: `Edit relay-${n}.ts`,
          detail: {
            kind: "file.edit",
            changes: [{ path: `packages/relay/src/relay-${n}.ts`, kind: "update", diff: diff(n) }],
          },
        }),
        facts.toolDone("root", id),
      ];
    default:
      return [
        facts.tool("root", id, {
          kind: "shell",
          title: `bunx vitest run relay/step-${n}.test.ts`,
          detail: { kind: "shell", command: `bunx vitest run relay/step-${n}.test.ts` },
        }),
        facts.output("root", id, output(n)),
        facts.toolDone("root", id),
      ];
  }
}

export function seedLongSteps(daemon: FakeDaemon): void {
  daemon.createThread(
    {
      hasSentMessage: true,
      id: "ios-log-long",
      workspaceId: "ace",
      title: "Long finished turns",
      provider: "claude",
    },
    (turns + 10) * minute,
  );
  daemon.apply("ios-log-long", [facts.rootAgent("claude")], (turns + 9) * minute);
  for (let turn = 0; turn < turns; turn++) {
    const work = Array.from({ length: stepsPerTurn }, (_, n) => step(turn, n)).flat();
    daemon.apply(
      "ios-log-long",
      [
        { type: "turn.started", agent: "root", nativeTurnId: `root-turn-${turn}`, trigger: "user" },
        facts.message("root", `ask-${turn}`, "user", `Keep relay cursors, part ${turn + 1}.`),
        ...work,
        facts.message("root", `answer-${turn}`, "assistant", answer(turn)),
        {
          type: "turn.ended",
          agent: "root",
          nativeTurnId: `root-turn-${turn}`,
          outcome: "completed",
        },
      ],
      (turns - turn) * minute,
    );
  }
}
