import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { closeDeckFixtures, deckFixture } from "./test-support.ts";
import { plan } from "./test-artifacts.ts";
import { ConductorReview } from "@ace/protocol";

afterEach(closeDeckFixtures);

test("prose surrounding a fenced artifact is admitted at the real provider boundary", async () => {
  const h = await deckFixture({
    artifactText: (_role, artifact) =>
      `Here is the result.\n\n\`\`\`json\n${JSON.stringify(artifact)}\n\`\`\`\nAll done.`,
  });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await h.settle();
  expect((await h.read()).plan).not.toBeNull();
  await h.waitFor((view) => view.phase === "done");
});

test("a malformed reviewer artifact receives validation feedback and corrects it in the same lane", async () => {
  const h = await deckFixture({
    artifactText: (role, artifact, attempt) =>
      role.includes("reviewer") && attempt === 1
        ? '{"kind":"review","revision":"bad","review":{}}'
        : JSON.stringify(artifact),
  });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await h.waitFor((view) => view.lanes.some((lane) => lane.role === "reviewer"));
  await h.settle();
  const corrections = h.sends.filter((send) => send.text.includes("Artifact validation failed"));
  expect(corrections).toHaveLength(1);
  expect(corrections[0]?.text).toContain("revision");
  await h.waitFor((view) => view.phase === "done");
  expect((await h.read()).delegations).toHaveLength(3);
});

test("repeated invalid artifacts get two correction turns then escalate, including across restart", async () => {
  const h = await deckFixture({
    stallAfterMs: 100,
    artifactText: (role, artifact) =>
      role.includes("reviewer")
        ? '{"kind":"review","revision":"bad","review":{}}'
        : JSON.stringify(artifact),
  });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await h.waitFor((view) =>
    view.lanes.some((lane) => lane.role === "reviewer" && lane.status === "done"),
  );
  await h.settle();
  expect(h.sends.filter((send) => send.text.includes("Artifact validation failed"))).toHaveLength(
    2,
  );
  await h.restart();
  await h.subscribe();
  await h.advance();
  expect(h.sends.filter((send) => send.text.includes("Artifact validation failed"))).toHaveLength(
    2,
  );
  expect((await h.read()).needsUser.some((gate) => gate.kind === "escalation")).toBe(true);
});

test("changes_required can report a blocking failure before running mutations or repeat checks", async () => {
  const cards = plan();
  const h = await deckFixture({
    cards: Object.assign({}, cards, {
      workstreams: cards.workstreams.map((card) =>
        Object.assign({}, card, {
          brief: Object.assign({}, card.brief, { acceptance: ["a works", "a survives restart"] }),
        }),
      ),
    }),
    mergeAsk: true,
    artifactText: (role, artifact) => {
      if (!role.includes("reviewer")) return JSON.stringify(artifact);
      const envelope = z
        .object({ revision: z.string(), review: z.object({ requirements: z.array(z.unknown()) }) })
        .parse(artifact);
      return JSON.stringify({
        kind: "review",
        revision: envelope.revision,
        review: {
          verdict: "changes_required",
          summary: "Acceptance blocked",
          requirements: [{ criterion: "a works", passed: false, evidence: "Build fails" }],
          probes: ["Build fails"],
          mutations: [],
          flakiness: { runs: 0, passed: false, evidence: "Blocked by build failure" },
          design: { passed: true, evidence: "Ownership checked" },
          performance: { passed: false, evidence: "Build blocked measurement" },
        },
      });
    },
  });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await h.waitFor((view) => view.lanes.some((lane) => lane.role === "reviewer"));
  await h.settle();
  expect((await h.read()).dag[0]?.reviews?.[0]?.verdict).toBe("changes_required");
  expect(
    ConductorReview.safeParse({
      verdict: "pass",
      summary: "Unsupported pass",
      requirements: [{ criterion: "a works", passed: true, evidence: "probe" }],
      probes: ["probe"],
      mutations: [],
      flakiness: { runs: 0, passed: true, evidence: "none" },
      design: { passed: true, evidence: "checked" },
      performance: { passed: true, evidence: "checked" },
    }).success,
  ).toBe(false);
});
