import { expect, it } from "vitest";
import { originFixture } from "./browser-origin-test-support.ts";

it.each(["ask", "auto-review"] as const)(
  "%s separates evaluate once, site read-only grants, revocation and downloads",
  async (mode) => {
    const f = await originFixture(mode),
      approvals = f.context.services.browserApprovals;
    if (!approvals) throw new Error("approvals");
    const id = f.thread.id;
    f.browser.originsGrant(id, "https://site.example");
    let opened = f.opened();
    const once = approvals.evaluate(id, "https://site.example/page", undefined, "unrestricted");
    let interaction = await opened;
    expect(interaction.request).toMatchObject({
      target: { tool: "browser.evaluate" },
      options: [{ id: "allow_once" }, { id: "deny" }],
    });
    expect(f.store.getInteraction(interaction.id)?.review).toBeUndefined();
    expect(f.resolve(interaction, "allow_once").ok).toBe(true);
    expect(await once).toBe(true);
    expect(f.browser.evaluateGrantsList(id)).toEqual([]);
    opened = f.opened();
    const site = approvals.evaluate(id, "https://site.example/next", undefined, "read-only");
    interaction = await opened;
    expect(f.resolve(interaction, "allow_site").ok).toBe(true);
    expect(await site).toBe(true);
    expect(await approvals.evaluate(id, "https://site.example/other", undefined, "read-only")).toBe(
      true,
    );
    const client = await f.client();
    expect(
      await client.request({
        type: "browser.evaluate.grants.list",
        threadId: id,
        requestId: "list",
      }),
    ).toMatchObject({ ok: true, result: [{ origin: "https://site.example", mode: "read-only" }] });
    expect(
      await client.request({
        type: "browser.evaluate.grants.revoke",
        threadId: id,
        requestId: "revoke",
        origin: "https://site.example",
      }),
    ).toMatchObject({ ok: true, result: [] });
    opened = f.opened();
    const revoked = approvals.evaluate(id, "https://site.example/other", undefined, "read-only");
    interaction = await opened;
    approvals.revoke(id, "https://site.example");
    await expect(revoked).rejects.toMatchObject({ code: "evaluate_approval_superseded" });
    expect(f.resolve(interaction, "allow_once").ok).toBe(false);
    opened = f.opened();
    const download = approvals.downloads(id, "https://site.example/file.zip");
    interaction = await opened;
    expect(interaction.request).toMatchObject({ target: { tool: "browser.downloads" } });
    expect(f.resolve(interaction, "deny").ok).toBe(true);
    expect(await download).toBe(false);
  },
);
it("evaluate site grants survive restart without granting unrestricted JavaScript", async () => {
  const f = await originFixture();
  const approvals = f.context.services.browserApprovals;
  if (!approvals) throw new Error("approvals");
  const opened = f.opened(),
    grant = approvals.evaluate(f.thread.id, "https://site.example", undefined, "read-only");
  expect(f.resolve(await opened, "allow_site").ok).toBe(true);
  expect(await grant).toBe(true);
  await f.close();
  const restarted = await originFixture("ask", f.home);
  expect(
    await restarted.context.services.browserApprovals?.evaluate(
      restarted.thread.id,
      "https://site.example/next",
      undefined,
      "read-only",
    ),
  ).toBe(true);
  const request = restarted.opened(),
    evaluate = restarted.context.services.browserApprovals?.evaluate(
      restarted.thread.id,
      "https://site.example/next",
      undefined,
      "unrestricted",
    );
  const interaction = await request;
  expect(restarted.resolve(interaction, "deny").ok).toBe(true);
  expect(await evaluate).toBe(false);
});
it("native full access still needs human consent for evaluation, downloads and outside uploads", async () => {
  const f = await originFixture("full-access"),
    approvals = f.context.services.browserApprovals;
  if (!approvals) throw new Error("approvals");
  f.browser.originsGrant(f.thread.id, "https://site.example");
  let opened = f.opened();
  const evaluate = approvals.evaluate(
    f.thread.id,
    "https://site.example",
    undefined,
    "unrestricted",
  );
  let interaction = await opened;
  expect(f.resolve(interaction, "allow_once").ok).toBe(true);
  expect(await evaluate).toBe(true);
  expect(await approvals.evaluate(f.thread.id, "about:blank")).toBe(false);
  opened = f.opened();
  const download = approvals.downloads(f.thread.id, "https://site.example/file");
  interaction = await opened;
  expect(f.resolve(interaction, "deny").ok).toBe(true);
  expect(await download).toBe(false);
  opened = f.opened();
  const upload = approvals.upload(f.thread.id, ["/outside/file"]);
  interaction = await opened;
  expect(interaction.request).toMatchObject({
    target: { tool: "browser.upload", input: { paths: ["/outside/file"] } },
  });
  expect(f.resolve(interaction, "deny").ok).toBe(true);
  expect(await upload).toBe(false);
});

it("shutdown expires pending permissions and refuses late decisions", async () => {
  const f = await originFixture(),
    approvals = f.context.services.browserApprovals;
  if (!approvals) throw new Error("approvals");
  const opened = f.opened(),
    download = approvals.downloads(f.thread.id, "https://site.example/file");
  const interaction = await opened;
  approvals.close();
  expect(await download).toBe(false);
  expect(f.store.getInteraction(interaction.id)?.state).toBe("expired");
  expect(f.resolve(interaction, "allow_once").ok).toBe(false);
});

it("an evaluate approval the person never answered reports superseded or timed out, never a cancel", async () => {
  const timers: { delay: number; work: () => void }[] = [];
  const f = await originFixture("ask", undefined, undefined, {
    now: () => 1000,
    set(delay, work) {
      const timer = { delay, work };
      timers.push(timer);
      return () => void timers.splice(timers.indexOf(timer), 1);
    },
  });
  const approvals = f.context.services.browserApprovals;
  if (!approvals) throw new Error("approvals");
  const id = f.thread.id;
  f.browser.originsGrant(id, "https://site.example");

  // Revoking the site while its request waits replaces that request: the agent hears why.
  let opened = f.opened();
  const revoked = approvals.evaluate(id, "https://site.example/a", undefined, "read-only");
  await opened;
  approvals.revoke(id, "https://site.example");
  const superseded = await revoked.then(
    () => new Error("approved"),
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
  expect(superseded).toMatchObject({ code: "evaluate_approval_superseded" });
  expect(superseded.message).toBe("Browser evaluate approval request superseded");
  expect(superseded.message).not.toMatch(/cancel/i);

  // Nobody answers within the minute: it times out, and says so.
  opened = f.opened();
  const waiting = approvals.evaluate(id, "https://site.example/b", undefined, "unrestricted");
  const interaction = await opened;
  const deadline = timers.find((timer) => timer.delay === 60_000);
  if (!deadline) throw new Error("no approval deadline");
  deadline.work();
  await expect(waiting).rejects.toMatchObject({
    code: "evaluate_approval_timeout",
    message: "Browser evaluate approval timed out",
  });
  expect(f.store.getInteraction(interaction.id)?.state).toBe("expired");

  // The person's own refusal is still a plain refusal.
  opened = f.opened();
  const denied = approvals.evaluate(id, "https://site.example/c", undefined, "unrestricted");
  expect(f.resolve(await opened, "deny").ok).toBe(true);
  expect(await denied).toBe(false);
});
