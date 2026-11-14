import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { SuitResponse, SuitSummary } from "@ace/protocol/suits";
import { suitsHttp, sceneCsp } from "./http.ts";
import { SuitLibrary } from "./library.ts";
import { nodeSuitSchedule, nodeSuitWatch } from "./watch.ts";

let home: string;
let root: string;
let library: SuitLibrary;
let server: Server;
let origin: string;

const manifest = (id: string, fields: Record<string, unknown> = {}) =>
  JSON.stringify({ format: 1, id, name: id, dark: { canvas: "#101014" }, ...fields });

async function suit(id: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, id, path, ".."), { recursive: true });
    await writeFile(join(root, id, path), text);
  }
}

function detail(response: SuitResponse) {
  if (response.op !== "read") throw new Error(`expected a read, got ${JSON.stringify(response)}`);
  return response.suit;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ace-suits-"));
  root = join(home, "suits");
  library = new SuitLibrary({
    root,
    key: new Uint8Array(32).fill(7),
    watch: nodeSuitWatch,
    schedule: nodeSuitSchedule,
    settleMs: 30,
  });
  await library.start();
  server = createServer(
    suitsHttp(
      () => library,
      new Set(["https://app.example"]),
      (_request, response) => {
        response.statusCode = 418;
        response.end();
      },
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  library.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
});

test("the library lists every Suit folder with its checks, and skips names that aren't ids", async () => {
  await suit("neon", { "suit.json": manifest("neon") });
  await suit("broken", { "suit.json": "{" });
  await mkdir(join(root, "Not An Id"));
  const listed = await library.list();
  expect(listed.map((entry) => [entry.id, entry.problems.length > 0])).toEqual([
    ["broken", true],
    ["neon", false],
  ]);
});

test("a read hands out the scene page and assets, served with the sandbox policy", async () => {
  await suit("neon", {
    "suit.json": manifest("neon", { fonts: { ui: { asset: "assets/ui.woff2", family: "Ui" } } }),
    "scene.js": "postMessage({ type: 'ready' }, '*')",
    "assets/ui.woff2": "font-bytes",
  });
  const suitDetail = detail(await library.read("neon"));
  expect(suitDetail.manifest.scene).toBe(true);
  const page = await fetch(origin + suitDetail.sceneUrl, { headers: { cookie: "a=b" } });
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toBe(sceneCsp);
  expect(page.headers.get("set-cookie")).toBeNull();
  expect(await page.text()).toContain('<script src="scene.js"></script>');
  const script = await fetch(new URL("scene.js", origin + suitDetail.sceneUrl));
  expect(await script.text()).toBe("postMessage({ type: 'ready' }, '*')");
  const font = await fetch(origin + suitDetail.assets["assets/ui.woff2"], {
    headers: { origin: "https://app.example" },
  });
  expect(font.headers.get("content-type")).toBe("font/woff2");
  expect(font.headers.get("access-control-allow-origin")).toBe("https://app.example");
  expect(await font.text()).toBe("font-bytes");
});

test("asset URLs need their grant, and stop serving once the Suit changes", async () => {
  await suit("neon", { "suit.json": manifest("neon"), "scene.js": "one()" });
  const url = detail(await library.read("neon")).sceneUrl ?? "";
  const forged = url.replace(/\/[a-f0-9]{32}\//, `/${"0".repeat(32)}/`);
  expect((await fetch(origin + forged)).status).toBe(404);
  const outside = url.replace("scene.html", "suit.json");
  expect((await fetch(origin + outside)).status).toBe(404);
  await writeFile(join(root, "neon", "scene.js"), "two()");
  expect((await fetch(origin + url)).status).toBe(404);
  const fresh = detail(await library.read("neon")).sceneUrl ?? "";
  expect(fresh).not.toBe(url);
  expect((await fetch(new URL("scene.js", origin + fresh))).status).toBe(200);
});

test("links are refused: a linked Suit folder and a linked file are never read or served", async () => {
  const outside = join(home, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "suit.json"), manifest("linked"));
  await writeFile(join(outside, "secret.png"), "secret");
  await symlink(outside, join(root, "linked"));
  await suit("neon", { "suit.json": manifest("neon") });
  await mkdir(join(root, "neon", "assets"));
  await symlink(join(outside, "secret.png"), join(root, "neon", "assets", "secret.png"));

  const linked = await library.validate("linked");
  expect(linked.op === "validate" && linked.summary.problems[0]?.check).toBe("schema");
  expect((await library.read("linked")).op).toBe("error");
  const neon = await library.validate("neon");
  expect(neon.op === "validate" && neon.summary.problems).toEqual([
    expect.objectContaining({ check: "asset", field: "assets/secret.png" }),
  ]);
  expect(detail(await library.read("neon")).assets).toEqual({});
});

test("removing a linked Suit removes the link and leaves what it pointed at", async () => {
  const outside = join(home, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "suit.json"), manifest("linked"));
  await symlink(outside, join(root, "linked"));
  expect(await library.remove("linked")).toEqual({ op: "remove", removed: true });
  expect(await readFile(join(outside, "suit.json"), "utf8")).toBe(manifest("linked"));
  expect(await library.list()).toEqual([]);
  expect(await library.remove("linked")).toEqual({ op: "remove", removed: false });
});

test("an edit on disk is announced once it settles, with the new list", async () => {
  const heard: SuitSummary[][] = [];
  library.subscribe((suits) => heard.push(suits));
  await suit("neon", { "suit.json": manifest("neon") });
  await vi.waitFor(() => expect(heard.at(-1)?.map((entry) => entry.id)).toEqual(["neon"]), {
    timeout: 3000,
  });
  await writeFile(join(root, "neon", "suit.json"), manifest("neon", { name: "Neon Night" }));
  await vi.waitFor(() => expect(heard.at(-1)?.[0]?.name).toBe("Neon Night"), { timeout: 3000 });
});
