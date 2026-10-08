import { once } from "node:events";
import { mkdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { BrowserBackendRequest } from "@ace/protocol";
import { backendFixture } from "./backend-test-support.ts";

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

it("a page a person holds stays paused after desktop loss until they act", async () => {
  const f = await backendFixture({ onError: () => {} });
  await f.service.open(agentOpen());
  f.service.takeover("thread", "person");
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

it("forgetting a deleted thread closes its browser and purges both persistent profiles", async () => {
  const f = await backendFixture({ profilePreference: () => "persistent" });
  await f.service.open(agentOpen());
  const key = createHash("sha256").update("workspace-thread:thread").digest("hex");
  const profile = join(f.home, "browser", "profiles", key);
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
  await expect(stat(profile)).rejects.toThrow();
});

it("forgetting a thread without a desktop reports the desktop purge as still owed", async () => {
  const f = await backendFixture();
  await f.disconnect();
  expect(await f.service.forgetThread("thread", "workspace-thread")).toEqual({ desktop: false });
});
