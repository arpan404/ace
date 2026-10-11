import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { BrowserArtifact, BrowserBackendLost } from "@ace/protocol";
import { backendFixture } from "./backend-test-support.ts";

it("failed private download cancellation exposes browser loss, removes bytes, and leaves a sibling usable", async () => {
  const artifacts: BrowserArtifact[] = [];
  const losses: BrowserBackendLost[] = [];
  const f = await backendFixture(
    {
      backendPreference: (options) => (options.threadId === "sibling" ? "headless" : "embedded"),
      onArtifact: (_thread, artifact) => {
        artifacts.push(artifact);
      },
      onBackendLost: (loss) => losses.push(loss),
    },
    { nativeTabs: true },
  );
  await f.open();
  const sessionId = [...f.pages.keys()][0];
  const sessionDir = (await readdir(join(f.home, "browser"))).find((name) =>
    name.startsWith("session-"),
  );
  if (!sessionId || !sessionDir) throw new Error("Browser session missing");
  const directory = join(f.home, "browser", sessionDir, "downloads");
  const guid = "native-11111111-1111-1111-1111-111111111111";
  await writeFile(join(directory, guid), "private bytes");
  await f.open("sibling");
  f.service.takeover("thread", "owner", "private");
  await f.service.input("thread", { kind: "key", event: "char", key: "x" }, "owner");
  // The real relay refuses the cancellation command at its transport boundary.
  f.pressure();
  f.sendEvent(sessionId, "ace.tabs.event", {
    tabId: "native-tab",
    method: "ace.download.started",
    params: {
      guid,
      url: "http://localhost/private.txt",
      filename: "private.txt",
      mimeType: "text/plain",
    },
  });
  await vi.waitFor(() =>
    expect(f.service.state("thread")).toMatchObject({
      status: "paused",
      closed: false,
      pageStateLost: true,
      reason: "Desktop browser transport backpressure",
      owner: "owner",
      takeoverMode: "private",
    }),
  );
  await vi.waitFor(async () => expect(await readdir(directory)).toEqual([]));
  expect(losses).toMatchObject([{ threadId: "thread", backend: "embedded", recovery: "pause" }]);
  expect(artifacts).toEqual([]);
  expect(f.service.downloadsList("thread")).toEqual([]);
  expect(f.service.state("sibling")).toMatchObject({ backend: "headless", status: "ready" });
  await expect(f.service.execute("sibling", { action: "snapshot" })).resolves.toMatchObject({
    nodes: [{ name: "Name" }],
  });
});
