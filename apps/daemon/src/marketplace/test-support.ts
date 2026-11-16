import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { gitRuntime, PluginManager, PluginService } from "@ace/plugins";
import type { MarketOperation, MarketResult } from "@ace/protocol/marketplace";
import { describeEntry, type ArchiveFile } from "@ace/marketplace";
import { keySetOf, testKey, type SignedVersion } from "@ace/marketplace/testing";
import type { Signed } from "@ace/marketplace";
import { SuitLibrary } from "../suits/library.ts";
import { pluginPort } from "./plugin-port.ts";
import { MarketplaceService } from "./service.ts";
import { spadePort } from "./spade-port.ts";

/*
 * A stand-in market.acehq.dev on a real local HTTP server, a stand-in Spade on another, and the
 * marketplace service wired to a real Suit library and plugin manager in a temporary ace root.
 */

const execute = promisify(execFile);

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

const send = (
  response: ServerResponse,
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
) => {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(body === undefined ? undefined : JSON.stringify(body));
};

export interface Listed {
  version: SignedVersion;
  files: ArchiveFile[];
}

/** The market's read routes over versions a test publishes. */
export async function fakeMarket() {
  const listed: Listed[] = [];
  let featured: { type: string; name: string }[] = [];
  let withdrawn: Signed | undefined;
  let stamp = 1;
  let down = false;
  /** Swaps an object's bytes, as a compromised Worker would. */
  const tampered = new Map<string, Uint8Array>();
  const requests: string[] = [];
  const latest = (type: string, name: string) =>
    listed.findLast((item) => item.version.type === type && item.version.name === name);
  const feedEntry = (item: Listed) => {
    const words = describeEntry(
      item.version.type,
      item.version.name,
      new Map(item.files.map((file) => [file.path, file.content])),
    );
    return {
      type: item.version.type,
      name: item.version.name,
      title: words.listing.title,
      line: words.listing.line,
      publisher: { id: "pub_test", name: "tester" },
      categories: words.listing.categories,
      keywords: words.listing.keywords,
      version: item.version.version,
      reviewed: item.version.review !== undefined,
      byAce: false,
      updated: stamp,
      downloads: 0,
    };
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(url.pathname + url.search);
    if (down) return send(response, 503, { error: "down" });
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (url.pathname === "/v1/index") {
      const keys = new Set(listed.map((item) => `${item.version.type}/${item.version.name}`));
      const entries = [...keys].map((key) => {
        const [type = "", name = ""] = key.split("/");
        return feedEntry(latest(type, name)!);
      });
      return send(
        response,
        200,
        { stamp, full: true, entries, removed: [] },
        { etag: `"${stamp}"` },
      );
    }
    if (url.pathname === "/v1/categories")
      return send(response, 200, { categories: [{ id: "mail", title: "Mail" }] });
    if (url.pathname === "/v1/featured") return send(response, 200, { entries: featured });
    if (url.pathname === "/v1/withdrawn")
      return withdrawn ? send(response, 200, withdrawn) : send(response, 404, { error: "none" });
    if (parts[0] === "v1" && parts[1] === "objects") {
      const item = listed.find((entry) => entry.version.hash === parts[2]);
      if (!item) return send(response, 404, { error: "not_found" });
      response.writeHead(200, { "content-type": "application/x-tar" });
      return response.end(tampered.get(item.version.hash) ?? item.version.archive);
    }
    if (parts[0] === "v1" && parts[1] === "entries") {
      const [, , type = "", name = "", version] = parts;
      const versions = listed.filter(
        (item) => item.version.type === type && item.version.name === name,
      );
      if (versions.length === 0) return send(response, 404, { error: "not_found" });
      if (version === undefined)
        return send(response, 200, {
          entry: feedEntry(versions.at(-1)!),
          description: "A test entry.",
          versions: versions.toReversed().map((item) => ({
            version: item.version.version,
            hash: item.version.hash,
            size: item.version.archive.byteLength,
            published: 1,
            downloads: 0,
          })),
        });
      const item = versions.find((entry) => entry.version.version === version);
      if (!item) return send(response, 404, { error: "not_found" });
      return send(response, 200, {
        manifest: item.version.manifest,
        ...(item.version.review ? { review: item.version.review } : {}),
      });
    }
    return send(response, 404, { error: "not_found" });
  });
  const port = await listen(server);
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    publish(version: SignedVersion, files: ArchiveFile[]) {
      listed.push({ version, files });
      stamp++;
    },
    feature(entries: { type: string; name: string }[]) {
      featured = entries;
    },
    withdraw(signed: Signed) {
      withdrawn = signed;
      stamp++;
    },
    tamper(hash: string, bytes: Uint8Array) {
      tampered.set(hash, bytes);
    },
    setDown(value: boolean) {
      down = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Spade's two routes the marketplace calls, recording what it was asked. */
export async function fakeSpade() {
  const made: Record<string, unknown>[] = [];
  const allowed = new Map<string, string[]>();
  let failCreate = false;
  const token = "spade-test-token";
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`)
      return send(response, 401, { error: "no" });
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body: unknown = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
      : undefined;
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/v1/agents") {
      if (failCreate) return send(response, 500, { error: "The bot couldn't be made" });
      made.push(body as Record<string, unknown>);
      return send(response, 201, { agent: { id: `bot_${made.length}` } });
    }
    const plugins = /^\/v1\/agents\/([^/]+)\/plugins$/.exec(url.pathname);
    if (plugins?.[1]) {
      const bot = decodeURIComponent(plugins[1]);
      if (request.method === "PUT") allowed.set(bot, (body as { plugins: string[] }).plugins);
      return send(response, 200, {
        plugins: (allowed.get(bot) ?? []).map((name) => ({ name, allowed: true })),
        cli: false,
      });
    }
    return send(response, 404, { error: "not found" });
  });
  const port = await listen(server);
  let running = true;
  return {
    made,
    allowed,
    connection: () => (running ? { host: "127.0.0.1", port, token } : undefined),
    setFailCreate(value: boolean) {
      failCreate = value;
    },
    setRunning(value: boolean) {
      running = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function git(root: string, args: string[]): Promise<string> {
  const result = await execute("git", args, {
    cwd: root,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  return result.stdout.trim();
}

/** A local git catalog holding `folders` (path → files) and its marketplace.json. */
export async function gitCatalog(
  root: string,
  catalog: unknown,
  folders: Record<string, ArchiveFile[]>,
): Promise<string> {
  const repo = join(root, "catalog");
  await mkdir(repo, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await writeFile(join(repo, "marketplace.json"), JSON.stringify(catalog));
  for (const [folder, files] of Object.entries(folders))
    for (const file of files) {
      const target = join(repo, folder, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, { mode: file.executable ? 0o755 : 0o644 });
    }
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "catalog"]);
  return repo;
}

/** The marketplace service in a temporary ace root, wired as the daemon wires it. */
export async function marketplaceHarness(options: {
  origin: string;
  spade: ReturnType<typeof fakeSpade> extends Promise<infer T> ? T : never;
}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-market-")));
  let clock = 1_700_000_000_000;
  let ids = 0;
  const id = () => `id-${++ids}`;
  const suits = new SuitLibrary({
    root: join(root, "suits"),
    key: new Uint8Array(32).fill(1),
    watch: () => undefined,
    schedule: () => () => {},
  });
  await suits.start();
  const manager = await PluginManager.open({ root: join(root, "plugins"), now: () => clock, id });
  const plugins = new PluginService(manager);
  const key = testKey();
  const service = await MarketplaceService.open({
    root: join(root, "marketplace"),
    now: () => clock,
    id,
    fetch: (url, init) => fetch(url, init),
    origin: options.origin,
    keys: keySetOf(key),
    git: gitRuntime(),
    suits: () => suits,
    plugins: () => pluginPort(() => plugins),
    spade: spadePort(options.spade.connection),
    schedule: () => () => {},
    allowLocalGit: true,
  });
  const ask = async <Op extends MarketResult["op"]>(
    operation: MarketOperation,
    op: Op,
  ): Promise<Extract<MarketResult, { op: Op }>> => {
    const result = await service.request(operation);
    if (result.op !== op)
      throw new Error(`Expected ${op}, got ${JSON.stringify(result).slice(0, 600)}`);
    return result as Extract<MarketResult, { op: Op }>;
  };
  return {
    root,
    service,
    suits,
    plugins,
    key,
    ask,
    advance(ms: number) {
      clock += ms;
    },
    async close() {
      service.close();
      suits.close();
      await plugins.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
