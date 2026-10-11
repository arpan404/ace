import { once } from "node:events";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import type { BrowserArtifact } from "@ace/protocol";
import { backendFixture } from "./backend-test-support.ts";

it.each(["published", "rejected"])(
  "private takeover during artifact publication keeps the download denied when publication is %s",
  async (outcome) => {
    const entered = Promise.withResolvers<BrowserArtifact>();
    const finish = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<void>();
    const artifacts: BrowserArtifact[] = [];
    onTestFinished(() => finish.resolve());
    const f = await backendFixture(
      {
        downloadPolicy: () => true,
        async onArtifact(_thread, artifact) {
          entered.resolve(artifact);
          try {
            await finish.promise;
            if (outcome === "rejected") throw new Error("Artifact publication failed");
            // Like the durable sink, retain the producer's original path.
            expect(await readFile(artifact.path, "utf8")).toBe("report bytes");
            artifacts.push(artifact);
          } finally {
            settled.resolve();
          }
        },
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
    await writeFile(join(directory, guid), "report bytes");
    const resumed = once(f.requests, "ace.download.resume");
    f.sendEvent(sessionId, "ace.tabs.event", {
      tabId: "native-tab",
      method: "ace.download.started",
      params: {
        guid,
        url: "http://localhost/report.txt",
        filename: "report.txt",
        mimeType: "text/plain",
      },
    });
    await resumed;
    f.sendEvent(sessionId, "ace.tabs.event", {
      tabId: "native-tab",
      method: "ace.download.progress",
      params: { guid, bytes: 12, state: "completed" },
    });
    const artifact = await entered.promise;
    f.service.takeover("thread", "owner", "private");
    await vi.waitFor(() =>
      expect(f.service.downloadsList("thread")).toMatchObject([{ state: "denied" }]),
    );
    // Cancellation must not delete bytes still owned by an unsettled publisher.
    expect(await readFile(artifact.path, "utf8")).toBe("report bytes");
    finish.resolve();
    await settled.promise;
    if (outcome === "published") {
      await vi.waitFor(() => expect(artifacts).toEqual([artifact]));
      expect(await readFile(artifacts[0]?.path ?? "", "utf8")).toBe("report bytes");
    } else {
      await vi.waitFor(async () => expect(await readdir(directory)).toEqual([]));
      expect(artifacts).toEqual([]);
    }
    f.service.handback("thread", "owner");
    await f.service.execute("thread", { action: "press", key: "Enter" });
    expect(f.service.downloadsList("thread")).toMatchObject([{ state: "denied" }]);
    expect(f.service.downloadsList("thread")[0]).not.toHaveProperty("path");
  },
);
