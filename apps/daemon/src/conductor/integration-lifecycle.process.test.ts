import { afterEach, expect, test } from "vitest";
import { closeDeckFixtures, deckFixture, git } from "./test-support.ts";
import { z } from "zod";
import { plan, review } from "./test-artifacts.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

afterEach(closeDeckFixtures);

test("a failed PR verification is reverted before decline and the dependant never starts", async () => {
  const h = await deckFixture({ prOnly: true, cards: plan({ a: [], b: ["a"] }) });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  const pending = await h.waitFor((run) => run.dag[0]?.state === "verifying");
  if (!pending.branch) throw new Error("Missing branch");
  h.forge.fail();
  await h.advance();
  const gated = await h.waitFor((run) => run.needsUser.some((gate) => gate.kind === "escalation"));
  const gate = gated.needsUser.find((entry) => entry.kind === "escalation");
  if (!gate) throw new Error("Missing escalation");
  expect(git(h.repo, "diff", h.original, pending.branch, "--")).toBe("");
  expect(
    git(join(h.home, "remote.git"), "diff", h.original, `refs/heads/${pending.branch}`, "--"),
  ).toBe("");
  expect(
    await h.commands({
      type: "conductor.approve",
      runId: h.runId,
      approval: { gateId: gate.id, decision: "reject" },
    }),
  ).toMatchObject({ ok: true });
  await h.settle();
  expect((await h.read()).dag.map((node) => node.state)).toEqual(["declined", "pending"]);
  expect((await h.read()).phase).toBe("done");
});

test("a conflict fix starts at the current Deck branch and is reviewed before integration", async () => {
  // Independent ownership, but both tasks touch a shared file at the provider boundary to
  // reproduce a real merge conflict rather than returning a synthetic merge_result.
  const h = await deckFixture({
    hold: true,
    parallel: 2,
    cards: plan({ a: [], b: [] }),
    onSend: (entry) => {
      if (entry.text.includes("Resolve merge conflict")) return;
      if (!entry.text.includes("Implement this workstream")) return;
      writeFileSync(join(entry.cwd, "shared.txt"), entry.text.includes("Build a") ? "a\n" : "b\n");
      git(entry.cwd, "add", "shared.txt");
      git(entry.cwd, "commit", "-m", "Shared edit");
    },
  });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await h.waitFor(
    (view) =>
      view.lanes.filter((lane) => lane.role === "worker" && lane.status === "working").length === 2,
  );
  const workers = h.sends.filter((send) => send.text.includes("Implement this workstream"));
  const first = workers[0],
    second = workers[1];
  if (!first || !second) throw new Error("Missing workers");
  await h.finish(first.thread);
  await h.waitFor((view) => view.dag.some((node) => node.state === "integrated"));
  await h.finish(second.thread);
  await h.waitFor((view) =>
    view.lanes.some(
      (lane) =>
        lane.role === "integrator" ||
        (lane.role === "worker" &&
          lane.id !== view.delegations.find((edge) => edge.threadId === second.thread)?.laneId),
    ),
  );
  await h.settle();
  const fix = h.sends.find((send) => send.text.includes("Resolve merge conflict"));
  if (!fix) throw new Error("Missing conflict fix");
  expect(readFileSync(join(fix.cwd, "shared.txt"), "utf8")).toBe(
    readFileSync(join(first.cwd, "shared.txt"), "utf8"),
  );
  const view = await h.read();
  expect(fix.text).toContain(view.branch);
  expect(fix.text).toContain(git(second.cwd, "rev-parse", "HEAD"));
  expect(h.daemon.store.getThread(fix.thread)?.deck?.role).toBe("integrator");
  await h.finish(fix.thread);
  const done = await h.waitFor((run) => run.phase === "done");
  expect(done.dag.map((node) => node.state)).toEqual(["integrated", "integrated"]);
  expect(done.dag.reduce((count, node) => count + (node.reviews?.length ?? 0), 0)).toBe(3);
});

test("cancel during pending PR CI reverts the unverified card and reaches cancelled", async () => {
  const h = await deckFixture({ prOnly: true });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  const run = await h.waitFor((view) => view.dag[0]?.state === "verifying");
  expect(await h.commands({ type: "conductor.cancel", runId: h.runId })).toMatchObject({
    ok: true,
  });
  await h.advance();
  expect((await h.read()).phase).toBe("cancelled");
  if (!run.branch) throw new Error("Missing branch");
  expect(git(h.repo, "diff", h.original, run.branch, "--")).toBe("");
});

async function conflictingWorkers(options: Parameters<typeof deckFixture>[0] = {}) {
  const h = await deckFixture({
    hold: true,
    parallel: 2,
    cards: plan({ a: [], b: [] }),
    onSend: (entry) => {
      if (
        entry.text.includes("Resolve merge conflict") ||
        !entry.text.includes("Implement this workstream")
      )
        return;
      writeFileSync(join(entry.cwd, "shared.txt"), entry.text.includes("Build a") ? "a\n" : "b\n");
      git(entry.cwd, "add", "shared.txt");
      git(entry.cwd, "commit", "-m", "Shared edit");
    },
    ...options,
  });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await h.waitFor(
    (view) =>
      view.lanes.filter((lane) => lane.role === "worker" && lane.status === "working").length === 2,
  );
  const [first, second] = h.sends.filter((send) => send.text.includes("Implement this workstream"));
  if (!first || !second) throw new Error("Missing workers");
  await h.finish(first.thread);
  await h.waitFor((view) => view.dag.some((node) => node.state === "integrated"));
  await h.finish(second.thread);
  return { h, first, second };
}

test("retrying a failed native integrator launches another integrator", async () => {
  const { h } = await conflictingWorkers({ failFirstIntegrator: true });
  const gated = await h.waitFor((run) => run.needsUser.some((gate) => gate.kind === "escalation"));
  const gate = gated.needsUser.find((entry) => entry.kind === "escalation");
  if (!gate) throw new Error("Missing escalation");
  expect(
    await h.commands({
      type: "conductor.approve",
      runId: h.runId,
      approval: { gateId: gate.id, decision: "approve" },
    }),
  ).toMatchObject({ ok: true });
  await h.waitFor((run) =>
    run.lanes.some((lane) => lane.role === "integrator" && lane.status === "working"),
  );
  const fixes = h.sends.filter((send) => send.text.includes("Resolve merge conflict"));
  expect(fixes).toHaveLength(2);
  expect(
    fixes.every((send) => h.daemon.store.getThread(send.thread)?.deck?.role === "integrator"),
  ).toBe(true);
});

test("a review fix after conflict resolution drops obsolete conflict text", async () => {
  let bReviews = 0;
  const { h } = await conflictingWorkers({
    artifactText: (role, artifact) => {
      if (role.includes("reviewer: b") && ++bReviews === 2) {
        const envelope = z.object({ revision: z.string() }).parse(artifact);
        return JSON.stringify({
          kind: "review",
          revision: envelope.revision,
          review: Object.assign({}, review("b"), {
            verdict: "changes_required",
            summary: "Fix acceptance",
            requirements: [{ criterion: "b works", passed: false, evidence: "Failing probe" }],
          }),
        });
      }
      return JSON.stringify(artifact);
    },
  });
  await h.waitFor((run) =>
    run.lanes.some((lane) => lane.role === "integrator" && lane.status === "working"),
  );
  const conflictFix = h.sends.find((send) => send.text.includes("Resolve merge conflict"));
  if (!conflictFix) throw new Error("Missing conflict fix");
  await h.finish(conflictFix.thread);
  await h.waitFor(
    (run) =>
      run.dag.some((node) => node.fixRounds === 1 && node.state === "working") &&
      run.lanes.some(
        (lane) => lane.role === "worker" && lane.workstream === "b" && lane.status === "working",
      ),
  );
  const reviewFix = h.sends.at(-1);
  if (!reviewFix) throw new Error("Missing review fix");
  // The portable handoff retains old instructions as quoted history.
  const currentPrompt = reviewFix.text.slice(
    reviewFix.text.lastIndexOf("\nImplement this workstream"),
  );
  expect(currentPrompt).toContain("Review to address");
  expect(currentPrompt).not.toContain("Resolve merge conflict");
});
