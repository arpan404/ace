import { expect, it, vi } from "vitest";
import { backendFixture } from "./backend-test-support.ts";
import { TabbedHeadless } from "./tabbed-test-support.ts";
import { keepAgentsOut } from "./collaboration-test-support.ts";

const human = { kind: "human", connectionId: "viewer" } as const;
const agent = { kind: "agent" } as const;

it("a paused session resumes when a person opens a tab", async () => {
  const f = await backendFixture(
    { onError: () => {}, headlessBackend: new TabbedHeadless() },
    { nativeTabs: true },
  );
  await f.open();
  await f.service.execute("thread", { action: "navigate", url: "http://localhost:3000/work" });
  await f.disconnect();
  expect(f.service.state("thread")).toMatchObject({ status: "paused" });
  // Person opens a new tab: resumes headlessly instead of throwing paused.
  const opened = await f.service.execute("thread", { action: "tabs", operation: "open" }, human);
  expect(f.service.state("thread")).toMatchObject({ backend: "headless", status: "ready" });
  expect(opened).toMatchObject({ activeTabId: expect.any(String) });
});

it("a paused session resumes when a person navigates", async () => {
  const f = await backendFixture({ onError: () => {} });
  await f.open();
  await f.service.execute("thread", { action: "navigate", url: "http://localhost:3000/work" });
  await f.disconnect();
  expect(f.service.state("thread")).toMatchObject({ status: "paused" });
  await f.service.execute(
    "thread",
    { action: "navigate", url: "http://localhost:3000/person" },
    human,
  );
  expect(f.service.state("thread")).toMatchObject({
    backend: "headless",
    status: "ready",
    url: "http://localhost:3000/person",
  });
});

it("a private paused session resumes for a person but not an agent", async () => {
  const f = await backendFixture({ onError: () => {} });
  await f.open();
  keepAgentsOut(f.service);
  await f.disconnect();
  expect(f.service.state("thread")).toMatchObject({ status: "paused" });
  // Agent stays paused (and stays out of the private tab).
  await expect(
    f.service.execute("thread", { action: "navigate", url: "http://localhost:3000/agent" }, agent),
  ).rejects.toThrow();
  expect(f.service.state("thread")).toMatchObject({ status: "paused" });
  // Person resumes.
  await f.service.execute(
    "thread",
    { action: "navigate", url: "http://localhost:3000/person" },
    human,
  );
  expect(f.service.state("thread")).toMatchObject({ backend: "headless", status: "ready" });
});

it("viewing a paused session resumes it", async () => {
  const f = await backendFixture({ onError: () => {} });
  await f.open();
  await f.service.execute("thread", { action: "navigate", url: "http://localhost:3000/work" });
  await f.disconnect();
  expect(f.service.state("thread")).toMatchObject({ status: "paused" });
  f.service.subscribe("thread", "viewer", {}, () => {});
  await vi.waitFor(() => expect(f.service.state("thread").status).toBe("ready"), {
    timeout: 5_000,
  });
  expect(f.service.state("thread")).toMatchObject({ backend: "headless" });
});
