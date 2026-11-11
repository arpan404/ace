import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { daemonFixture } from "../agent-control/daemon-test-support.ts";
import { fakeHeadlessBackend } from "../browser-mcp-test-support.ts";
import { invoke } from "../cli-test-support.ts";
import {
  adminWindow,
  call,
  enroll,
  listed,
  toolResult,
  rpc,
  type Fixture,
} from "./outside-test-support.ts";

// One daemon for the file; registered after the fixture's own afterAll, so it closes before
// its home goes. Each test enrolls its own grants.
const closers: (() => unknown)[] = [];
let shared: Promise<Fixture> | undefined;
beforeAll(() => {
  shared = daemonFixture(undefined, { browser: { headlessBackend: fakeHeadlessBackend() } });
});
afterAll(async () => {
  for (const close of closers.splice(0).toReversed()) await close();
  await (await shared)?.daemon.close();
});
async function fixture() {
  if (!shared) throw new Error("No daemon");
  return shared;
}
test("a read-only grant lists only reads and every change it tries is refused with insufficient_scope", async () => {
  const f = await fixture();
  const lease = await enroll(f, ["--scope", "read"]);
  const names = await listed(lease);
  expect(names).toEqual(
    expect.arrayContaining(["ace_projects_list", "ace_models_list", "ace_thread_read"]),
  );
  for (const name of ["ace_thread_run", "ace_thread_send", "ace_thread_stop", "browser_open"])
    expect(names).not.toContain(name);
  const before = f.daemon.store.listThreads().length;
  const attempts: [string, unknown, string][] = [
    [
      "ace_thread_run",
      { project: f.workspace, provider: "codex", text: "x", idempotencyKey: "k" },
      "threads:start",
    ],
    [
      "ace_thread_send",
      { threadId: f.caller.threadId, text: "x", idempotencyKey: "k" },
      "threads:message",
    ],
    ["ace_thread_stop", { threadId: f.caller.threadId, idempotencyKey: "k" }, "threads:stop"],
    [
      "ace_task_control",
      { operation: { op: "task.cancel", threadId: f.caller.threadId, key: "k" } },
      "threads:stop",
    ],
    ["browser_open", { url: "https://example.com" }, "browser"],
    ["screen_apps", {}, "computer"],
  ];
  for (const [name, args, scope] of attempts) {
    const refused = await call(lease, name, args);
    expect(refused.status, name).toBe(403);
    expect(refused.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    expect(refused.headers.get("www-authenticate")).toContain(`scope="${scope}"`);
  }
  // A dispatched call is held to the scope of the tool it runs.
  const dispatched = await call(lease, "tools_call", {
    name: "ace_thread_stop",
    arguments: { threadId: f.caller.threadId, idempotencyKey: "k" },
  });
  expect(dispatched.status).toBe(403);
  expect(f.daemon.store.listThreads()).toHaveLength(before);
  // Reads work.
  expect(toolResult(await call(lease, "ace_projects_list", {})).structuredContent).toMatchObject({
    ok: true,
    data: { projects: [{ id: f.workspace }] },
  });
});

test("each scope offers exactly its own tools", async () => {
  const f = await fixture();
  const own: Record<string, string[]> = {
    "threads:start": ["ace_thread_run"],
    "threads:message": ["ace_thread_send"],
    "threads:stop": ["ace_thread_stop"],
    browser: ["browser_open", "browser_act"],
  };
  for (const [scope, tools] of Object.entries(own)) {
    const names = await listed(await enroll(f, ["--allow", scope]));
    expect(names, scope).toEqual(expect.arrayContaining(["ace_threads_list", ...tools]));
    for (const [other, theirs] of Object.entries(own))
      if (other !== scope) for (const tool of theirs) expect(names, scope).not.toContain(tool);
  }
});

test("a grant limited to one project neither sees nor starts work in another", async () => {
  const f = await fixture();
  await mkdir(join(f.h.home, "other"));
  const other = f.daemon.store.createWorkspace(join(f.h.home, "other"), "other");
  const lease = await enroll(f, ["--allow", "threads:start", "--project", f.workspace]);
  const run = toolResult(
    await call(lease, "ace_thread_run", {
      project: other,
      provider: "codex",
      text: "elsewhere",
      idempotencyKey: "other",
    }),
  );
  expect(run.structuredContent).toMatchObject({ ok: false, error: "forbidden" });
  expect(toolResult(await call(lease, "ace_projects_list", {})).structuredContent).toMatchObject({
    data: { projects: [{ id: f.workspace }] },
  });
  const wide = await enroll(f, ["--scope", "read", "--project", other]);
  expect(
    toolResult(await call(wide, "ace_thread_read", { threadId: f.caller.threadId })).isError,
  ).toBe(true);
});

test("revoking or expiring a grant ends its token on the next request", async () => {
  const f = await fixture();
  const admin = await adminWindow(f, closers);
  const revoked = await enroll(f, ["--scope", "read"]);
  expect((await rpc(revoked, "tools/list")).status).toBe(200);
  expect(await admin({ op: "revoke", grantId: revoked.id })).toEqual({ kind: "revoked" });
  const after = await rpc(revoked, "tools/list");
  expect(after.status).toBe(401);
  expect(after.headers.get("www-authenticate")).toMatch(/^Bearer/);
  const expiring = await enroll(f, ["--scope", "read"]);
  const soon = f.h.clock.now() + 60_000;
  const updated = await admin({ op: "update", grantId: expiring.id, expiresAt: soon });
  expect(updated).toMatchObject({ kind: "updated", grant: { expiresAt: soon } });
  expect((await rpc(expiring, "tools/list")).status).toBe(200);
  f.h.clock.advance(soon);
  expect((await rpc(expiring, "tools/list")).status).toBe(401);
  // The revoked grant's row stays, so history can still name the client.
  const grants = await admin({ op: "grants" });
  expect(grants).toMatchObject({
    kind: "grants",
    grants: expect.arrayContaining([
      expect.objectContaining({ id: revoked.id, revokedAt: expect.any(Number) }),
    ]),
  });
  expect(JSON.stringify(grants)).not.toContain(revoked.bearer);
});

test("a grant's browser tabs belong to it and close when it is revoked", async () => {
  const f = await fixture();
  const lease = await enroll(f, ["--allow", "browser"]);
  const opened = toolResult(await call(lease, "browser_open", { url: "https://example.com/" }));
  expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
  const session = `external:${lease.id}`;
  expect(f.daemon.browser.state(session)).toMatchObject({
    closed: false,
    url: "https://example.com/",
  });
  const revoked = await invoke(join(f.h.home, "daemon"), ["mcp", "revoke", lease.id, "--json"]);
  expect(revoked.code, revoked.stderr).toBe(0);
  await expect
    .poll(() => {
      try {
        return f.daemon.browser.state(session).closed;
      } catch {
        return true;
      }
    })
    .toBe(true);
});
