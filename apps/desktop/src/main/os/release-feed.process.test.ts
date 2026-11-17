import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { checkReleaseFeed, type FeedPorts } from "./release-feed.ts";

/**
 * A stand-in for github.com and its API on loopback: the release list, and each release's
 * download folder behind a redirect to separate storage, as GitHub's downloads are.
 */
interface Release {
  tag: string;
  prerelease: boolean;
  draft?: boolean;
  files: Record<string, string>;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function github(releases: Release[], options: { listStatus?: number } = {}) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    requests.push(url.pathname);
    if (url.pathname === "/repos/arpan404/ace/releases") {
      if (options.listStatus) {
        response.writeHead(options.listStatus, { "content-type": "application/json" });
        return response.end('{"message":"API rate limit exceeded"}');
      }
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(
        JSON.stringify(
          releases.map((release) => ({
            tag_name: release.tag,
            draft: release.draft ?? false,
            prerelease: release.prerelease,
            body: `- Changes in ${release.tag}`,
          })),
        ),
      );
    }
    const download = /^\/download\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (download) {
      response.writeHead(302, { location: `/storage/${download[1]}/${download[2]}` });
      return response.end();
    }
    const stored = /^\/storage\/([^/]+)\/(.+)$/.exec(url.pathname);
    const body = stored
      ? releases.find((release) => release.tag === decodeURIComponent(stored[1] ?? ""))?.files[
          stored[2] ?? ""
        ]
      : undefined;
    if (body === undefined) {
      response.writeHead(404);
      return response.end("Not Found");
    }
    response.writeHead(200);
    response.end(body);
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ports: FeedPorts = {
    fetch: globalThis.fetch,
    urls: {
      api: `${origin}/repos/arpan404/ace/releases?per_page=100`,
      download: `${origin}/download/`,
      page: `${origin}/tag/`,
    },
  };
  return { ports, requests };
}

const feed = (version: string) => `version: ${version}\npath: ace-${version}-arm64-mac.zip\n`;
const data = (daemon: number) => JSON.stringify({ home: 1, daemon, notify: 5, spade: 9 });
const stable023: Release = {
  tag: "v0.0.23",
  prerelease: false,
  files: { "latest-mac.yml": feed("0.0.23"), "ace-data.json": data(63) },
};
const beta = (daemon: number): Release => ({
  tag: "ace-beta-2026-11-16-0.0.24-1",
  prerelease: true,
  files: { "latest-mac.yml": feed("0.0.24-beta.20261116.1"), "ace-data.json": data(daemon) },
});
const home = (daemon: number) => ({ home: 1, daemon, notify: 5, spade: 9 });

describe("the release feed against GitHub's shape", () => {
  it("points the updater at the newest beta's own folder, which serves that beta's feed", async () => {
    const { ports } = await github([beta(63), stable023]);
    const result = await checkReleaseFeed(ports, {
      installed: "0.0.23",
      line: "beta",
      home: home(63),
    });
    expect(result).toMatchObject({
      kind: "offer",
      tag: "ace-beta-2026-11-16-0.0.24-1",
      version: "0.0.24-beta.20261116.1",
      older: false,
      notes: [
        { version: "0.0.24-beta.20261116.1", note: "- Changes in ace-beta-2026-11-16-0.0.24-1" },
      ],
    });
    if (result.kind !== "offer") return;
    // What electron-updater's generic provider reads next, through GitHub's redirect.
    const yml = await (await fetch(`${result.feedUrl}latest-mac.yml`)).text();
    expect(yml).toContain("version: 0.0.24-beta.20261116.1");
  });

  it("moves a beta install onto its own version's stable without reading any release's data", async () => {
    const stable024: Release = {
      tag: "v0.0.24",
      prerelease: false,
      files: { "latest-mac.yml": feed("0.0.24"), "ace-data.json": data(64) },
    };
    const { ports, requests } = await github([stable024, beta(64), stable023]);
    const result = await checkReleaseFeed(ports, {
      installed: "0.0.24-beta.20261116.1",
      line: "stable",
      home: home(64),
    });
    expect(result).toMatchObject({ kind: "offer", tag: "v0.0.24", older: false });
    expect(requests.some((path) => path.endsWith("ace-data.json"))).toBe(false);
  });

  it("lets a beta that changed no data go back to stable", async () => {
    const { ports } = await github([beta(63), stable023]);
    const result = await checkReleaseFeed(ports, {
      installed: "0.0.24-beta.20261116.1",
      line: "stable",
      home: home(63),
    });
    expect(result).toMatchObject({ kind: "offer", tag: "v0.0.23", older: true });
  });

  it("keeps a beta that migrated on beta, and says why", async () => {
    const { ports } = await github([beta(64), stable023]);
    const result = await checkReleaseFeed(ports, {
      installed: "0.0.24-beta.20261116.1",
      line: "stable",
      home: home(64),
    });
    expect(result).toEqual({
      kind: "blocked",
      message:
        "Stable can't read this beta's data yet. You can switch once stable reaches a newer release.",
    });
  });

  it("counts a stable release without ace-data.json as unable to read the beta's data", async () => {
    const { ports, requests } = await github([
      beta(63),
      { ...stable023, files: { "latest-mac.yml": feed("0.0.23") } },
    ]);
    const result = await checkReleaseFeed(ports, {
      installed: "0.0.24-beta.20261116.1",
      line: "stable",
      home: home(63),
    });
    expect(result.kind).toBe("blocked");
    expect(requests).toContain("/storage/v0.0.23/ace-data.json");
  });

  it("reads no release's data for an update that moves forward", async () => {
    const { ports, requests } = await github([beta(63), stable023]);
    await checkReleaseFeed(ports, { installed: "0.0.22", line: "stable", home: undefined });
    expect(requests.some((path) => path.endsWith("ace-data.json"))).toBe(false);
  });

  it("fails the check when GitHub refuses the list, rather than call ace current", async () => {
    const { ports } = await github([stable023], { listStatus: 403 });
    await expect(
      checkReleaseFeed(ports, { installed: "0.0.22", line: "stable", home: undefined }),
    ).rejects.toThrow("403");
  });
});
