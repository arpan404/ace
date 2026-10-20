import { once } from "node:events";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { BrowserBackendRequest } from "@ace/protocol";
import { backendFixture } from "./backend-test-support.ts";
import { keepAgentsOut } from "./collaboration-test-support.ts";

const agentOpen = (threadId = "thread") => ({
  threadId,
  workspaceId: `workspace-${threadId}`,
  background: true,
});

it("an agent drives the desktop's native view when a desktop is registered", async () => {
  const f = await backendFixture();
  expect(await f.service.open(agentOpen())).toMatchObject({ backend: "embedded" });
  await f.service.execute(
    "thread",
    { action: "navigate", url: "http://localhost:3000/agent" },
    { kind: "agent" },
  );
  expect([...f.pages.values()].map((page) => page.url)).toEqual(["http://localhost:3000/agent"]);
  expect(f.headless.pages).toHaveLength(0);
});

it("an agent joins the native page a person opened instead of replacing it", async () => {
  const f = await backendFixture();
  await f.open();
  await f.service.execute("thread", { action: "navigate", url: "http://localhost:3000/person" });
  expect(await f.service.open(agentOpen())).toMatchObject({
    backend: "embedded",
    url: "http://localhost:3000/person",
  });
  expect(f.pages.size).toBe(1);
  expect(f.headless.pages).toHaveLength(0);
});

it("auto continues in headless Chromium when the desktop cannot open a view", async () => {
  const f = await backendFixture({ onError: () => {} });
  f.failOpen("No ace window is open");
  expect(await f.service.open(agentOpen())).toMatchObject({ backend: "headless" });
  expect(f.headless.pages).toHaveLength(1);
});

it("an explicit desktop preference reports a failed native open instead of falling back", async () => {
  const f = await backendFixture({ backendPreference: () => "embedded" });
  f.failOpen("No ace window is open");
  await expect(f.service.open(agentOpen())).rejects.toThrow("No ace window is open");
  expect(f.headless.pages).toHaveLength(0);
});

it("agent work resumes headlessly at the last URL after the desktop goes away", async () => {
  const f = await backendFixture({ onError: () => {} });
  await f.service.open(agentOpen());
  await f.service.execute(
    "thread",
    { action: "navigate", url: "http://localhost:3000/work" },
    { kind: "agent" },
  );
  await f.disconnect();
  expect(f.service.state("thread")).toMatchObject({ status: "paused" });
  expect(await f.service.open(agentOpen())).toMatchObject({
    backend: "headless",
    url: "http://localhost:3000/work",
    pageStateLost: true,
  });
  expect(f.headless.pages.map((page) => page.url)).toEqual(["http://localhost:3000/work"]);
});

it("a page the person keeps private stays paused after desktop loss until they act", async () => {
  const f = await backendFixture({ onError: () => {} });
  await f.service.open(agentOpen());
  keepAgentsOut(f.service);
  await f.disconnect();
  expect(await f.service.open(agentOpen())).toMatchObject({ status: "paused" });
  expect(f.headless.pages).toHaveLength(0);
});

it("an unnamed profile follows the profile preference", async () => {
  const f = await backendFixture({
    backendPreference: () => "headless",
    profilePreference: () => "persistent",
  });
  await f.service.open(agentOpen());
  expect(f.headless.opens[0]?.options.profile).toBe("persistent");
});

it("forgetting a deleted thread closes its browser and purges its desktop partition, keeping ace's shared profile", async () => {
  const f = await backendFixture({ profilePreference: () => "persistent" });
  await f.service.open(agentOpen());
  const profile = join(f.home, "browser", "profile");
  await mkdir(join(profile, "Default"), { recursive: true });
  const purge = once(f.requests, "purge");
  expect(await f.service.forgetThread("thread", "workspace-thread")).toEqual({ desktop: true });
  const [request] = (await purge) as [BrowserBackendRequest];
  expect(request.operation).toEqual({
    kind: "purge",
    threadId: "thread",
    workspaceId: "workspace-thread",
  });
  expect(() => f.service.state("thread")).toThrow("not open");
  // Every thread shares this profile's sign-ins; one thread's deletion keeps them.
  expect((await stat(join(profile, "Default"))).isDirectory()).toBe(true);
});

it("forgetting a thread without a desktop reports the desktop purge as still owed", async () => {
  const f = await backendFixture();
  await f.disconnect();
  expect(await f.service.forgetThread("thread", "workspace-thread")).toEqual({ desktop: false });
});

it("the desktop opens a kept page in the profile scope the daemon chose", async () => {
  const f = await backendFixture({
    profilePreference: (open) => (open.threadId === "private" ? "ephemeral" : "persistent"),
    profileScope: () => "project",
  });
  const opened = once(f.requests, "open");
  await f.service.open(agentOpen());
  const [kept] = (await opened) as [BrowserBackendRequest];
  expect(kept.operation).toMatchObject({ kind: "open", profileScope: "project" });
  // A private page's partition is a throwaway one: no project profile is asked for.
  const privately = once(f.requests, "open");
  await f.service.open(agentOpen("private"));
  const [throwaway] = (await privately) as [BrowserBackendRequest];
  expect(throwaway.operation).toMatchObject({ kind: "open", profileScope: "global" });
});

it("removing a project closes its pages and purges its desktop partition, leaving other projects'", async () => {
  const f = await backendFixture({ profileScope: () => "project" });
  await f.service.open(agentOpen());
  await f.service.open(agentOpen("other"));
  const purge = once(f.requests, "purgeProject");
  expect(await f.service.forgetProject("workspace-thread")).toEqual({ desktop: true });
  const [request] = (await purge) as [BrowserBackendRequest];
  expect(request.operation).toEqual({ kind: "purgeProject", workspaceId: "workspace-thread" });
  expect(() => f.service.state("thread")).toThrow("not open");
  expect(f.service.state("other").closed).toBe(false);
});
