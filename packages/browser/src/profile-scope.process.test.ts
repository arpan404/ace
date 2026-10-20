import { describe, expect, it } from "vitest";
import type { BrowserProfileScope } from "@ace/protocol";
import { executablePath, fixture } from "./test-support.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Signs the thread's browser in to the test site with a lasting cookie. */
async function signIn(f: Fixture, threadId: string) {
  await f.service.execute(threadId, { action: "navigate", url: f.url });
  await f.service.execute(threadId, {
    action: "evaluate",
    expression: "document.cookie = 'sid=signed-in; max-age=3600'; true",
  });
}
/** The cookie the thread's browser holds for the test site, opening it first if needed. */
async function cookie(f: Fixture, threadId: string, workspaceId: string) {
  await f.service.open({ threadId, workspaceId });
  await f.service.execute(threadId, { action: "navigate", url: f.url });
  return f.service.execute(threadId, { action: "evaluate", expression: "document.cookie" });
}
const scoped = (scope: BrowserProfileScope) => fixture({ profileScope: () => scope });

describe.skipIf(!executablePath)("browser profile scopes in ace's Chrome", () => {
  it("by default every project's threads share one profile's sign-ins", async () => {
    const f = await fixture();
    await signIn(f, "thread");
    expect(await cookie(f, "elsewhere", "other-project")).toBe("sid=signed-in");
  }, 60_000);

  it("a project scope keeps each project's sign-ins apart, shared by that project's threads", async () => {
    const f = await scoped("project");
    await signIn(f, "thread");
    expect(await cookie(f, "neighbour", "workspace")).toBe("sid=signed-in");
    expect(await cookie(f, "elsewhere", "other-project")).toBe("");
  }, 60_000);

  it("a thread scope gives each thread its own sign-ins, gone when the thread is deleted", async () => {
    const f = await scoped("thread");
    await signIn(f, "thread");
    expect(await cookie(f, "neighbour", "workspace")).toBe("");
    expect(await cookie(f, "thread", "workspace")).toBe("sid=signed-in");

    await f.service.forgetThread("thread", "workspace");

    expect(await cookie(f, "thread", "workspace")).toBe("");
  }, 60_000);

  it("removing a project closes its browsers and forgets its sign-ins, not other projects'", async () => {
    const f = await scoped("project");
    await signIn(f, "thread");
    await f.service.open({ threadId: "elsewhere-thread", workspaceId: "other-project" });
    await signIn(f, "elsewhere-thread");

    await f.service.forgetProject("workspace");

    expect(f.service.hasActiveSession("thread")).toBe(false);
    expect(f.service.hasActiveSession("elsewhere-thread")).toBe(true);
    expect(await cookie(f, "thread", "workspace")).toBe("");
    expect(await cookie(f, "elsewhere-thread", "other-project")).toBe("sid=signed-in");
  }, 60_000);
});
