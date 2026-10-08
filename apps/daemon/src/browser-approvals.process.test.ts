import { codexReviewerMode } from "@ace/provider-kit/permission-modes";
import { expect, it } from "vitest";
import { originFixture } from "./browser-origin-test-support.ts";

it.each([":workspace", codexReviewerMode("auto_review")])(
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
    expect(await revoked).toBe(false);
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
  const f = await originFixture(":danger-full-access"),
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
