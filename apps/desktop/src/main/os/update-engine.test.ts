import type { HomeData } from "@ace/protocol";
import type { ReleaseLine } from "@ace/service/release-line";
import { describe, expect, it } from "vitest";
import { feedEngine, type FeedUpdater } from "./update-engine.ts";

const download = "https://github.test/download/";
const stable023 = { tag_name: "v0.0.23", draft: false, prerelease: false, body: "- Stable" };
const beta = (n: number) => ({
  tag_name: `ace-beta-2026-11-16-0.0.24-${n}`,
  draft: false,
  prerelease: true,
  body: `- Beta ${n}`,
});
const versionOf = (url: string) => {
  const tag = decodeURIComponent(url.slice(download.length).replace(/\/$/, ""));
  const n = /-(\d+)$/.exec(tag)?.[1];
  return tag.startsWith("v") ? tag.slice(1) : `0.0.24-beta.20261116.${n}`;
};

/**
 * electron-updater as the engine sees it: one check at a time (a call while one runs gets that
 * one's promise), answering for the folder it was pointed at when the check began. A test may
 * hold a folder's answer to play a check that outlives the engine's timeout.
 */
function updater() {
  let feed = "";
  let running: Promise<{ isUpdateAvailable: boolean; updateInfo: { version: string } }> | undefined;
  const held = new Map<string, () => void>();
  const holding = new Set<string>();
  const downloads: string[] = [];
  const fake: FeedUpdater = {
    autoInstallOnAppQuit: true,
    allowDowngrade: false,
    setFeedURL(options) {
      feed = options.url;
    },
    checkForUpdates() {
      if (running) return running;
      const url = feed;
      const answer = { isUpdateAvailable: true, updateInfo: { version: versionOf(url) } };
      running = new Promise((resolve) => {
        const finish = () => {
          running = undefined;
          current = answer.updateInfo.version;
          resolve(answer);
        };
        if (holding.has(url)) held.set(url, finish);
        else queueMicrotask(finish);
      });
      return running;
    },
    async downloadUpdate() {
      downloads.push(current);
    },
    quitAndInstall() {},
  };
  /** The version electron-updater would download: its last finished check's. */
  let current = "";
  return {
    fake,
    downloads,
    hold: (tag: string) => holding.add(`${download}${tag}/`),
    release: (tag: string) => held.get(`${download}${tag}/`)?.(),
  };
}

function engine(input: {
  installed: string;
  line?: ReleaseLine;
  releases: () => unknown[];
  data?: Record<string, unknown>;
  home?: HomeData;
  freshHome?: () => HomeData | undefined;
}) {
  const u = updater();
  const fetch: typeof globalThis.fetch = async (request) => {
    const url = String(request);
    if (url.startsWith("https://api.test/")) return Response.json(input.releases());
    const file = url.slice(download.length);
    const data = input.data?.[file];
    return data ? Response.json(data) : new Response("Not Found", { status: 404 });
  };
  const subject = feedEngine({
    updater: u.fake,
    squirrel: null,
    canInstall: true,
    installed: input.installed,
    line: () => input.line ?? "beta",
    homeData: () => input.home,
    freshHomeData: async () => input.freshHome?.() ?? input.home,
    feed: {
      fetch,
      urls: { api: "https://api.test/releases", download, page: "https://page.test/" },
    },
    onProgress: () => {},
    checkTimeoutMs: 20,
    squirrelVerdictMs: 1_000,
    log: () => {},
  });
  return { subject, updater: u };
}

describe("the update engine", () => {
  it("downloads the offer of its last successful check, even when a timed-out check finishes later", async () => {
    let list = [beta(1), stable023];
    const { subject, updater: u } = engine({ installed: "0.0.23", releases: () => list });
    expect(await subject.check()).toMatchObject({ version: "0.0.24-beta.20261116.1" });

    // Beta 2 appears, but its check outlives the timeout, then finishes anyway.
    list = [beta(2), beta(1), stable023];
    u.hold("ace-beta-2026-11-16-0.0.24-2");
    await expect(subject.check()).rejects.toThrow("timed out");
    u.release("ace-beta-2026-11-16-0.0.24-2");

    await subject.download(() => {});
    expect(u.downloads).toEqual(["0.0.24-beta.20261116.1"]);
  });

  it("waits out a check still running inside the updater before it downloads", async () => {
    let list = [beta(1), stable023];
    const { subject, updater: u } = engine({ installed: "0.0.23", releases: () => list });
    await subject.check();
    list = [beta(2), beta(1), stable023];
    u.hold("ace-beta-2026-11-16-0.0.24-2");
    await expect(subject.check()).rejects.toThrow("timed out");
    const downloading = subject.download(() => {});
    u.release("ace-beta-2026-11-16-0.0.24-2");
    await downloading;
    expect(u.downloads).toEqual(["0.0.24-beta.20261116.1"]);
  });

  it("allows a downgrade and keeps install-on-quit off only for a guarded switch back", async () => {
    const formats = { home: 1, daemon: 33, notify: 5, spade: 7 };
    const back = engine({
      installed: "0.0.24-beta.20261116.1",
      line: "stable",
      releases: () => [beta(1), stable023],
      data: { "v0.0.23/ace-data.json": formats },
      home: { ...formats, spade: null },
    });
    expect(await back.subject.check()).toMatchObject({ version: "0.0.23" });
    await back.subject.download(() => {});
    expect(back.updater.fake).toMatchObject({ allowDowngrade: true, autoInstallOnAppQuit: false });

    const forward = engine({ installed: "0.0.23", releases: () => [beta(1), stable023] });
    await forward.subject.check();
    await forward.subject.download(() => {});
    expect(forward.updater.fake).toMatchObject({
      allowDowngrade: false,
      autoInstallOnAppQuit: true,
    });
  });

  it("refuses a downloaded switch back once the home gains a format the release can't read", async () => {
    const formats = { home: 1, daemon: 33, notify: 5, spade: 7 };
    let spade: number | null = null;
    const { subject } = engine({
      installed: "0.0.24-beta.20261116.1",
      line: "stable",
      releases: () => [beta(1), stable023],
      data: { "v0.0.23/ace-data.json": formats },
      home: { ...formats, spade: null },
      freshHome: () => ({ ...formats, spade }),
    });
    await subject.check();
    await subject.download(() => {});
    expect(await subject.recheck?.()).toBeUndefined();
    // Spade starts for the first time, on the beta's schema.
    spade = 15;
    expect(await subject.recheck?.()).toEqual({
      blocked:
        "Stable can't read this beta's data yet. You can switch once stable reaches a newer release.",
    });
  });

  it("has nothing to look at again for a forward update", async () => {
    const { subject } = engine({ installed: "0.0.23", releases: () => [beta(1), stable023] });
    await subject.check();
    expect(subject.recheck?.()).toBeUndefined();
  });
});
