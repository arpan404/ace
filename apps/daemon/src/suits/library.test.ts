import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { SuitResponse, SuitSummary } from "@ace/protocol/suits";
import { seedBuiltinSuits } from "@ace/plugins";
import { sceneRuntimeScript } from "@ace/suit-scene-runtime";
import { sceneCsp, sceneRuntimeFile, suitsHttp } from "./http.ts";
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
  // ace's runtime first, then the Suit's scene, both same-origin as `script-src 'self'` allows.
  const scripts = [...(await page.text()).matchAll(/<script src="([^"]+)"><\/script>/g)].map(
    (match) => match[1],
  );
  expect(scripts).toEqual([sceneRuntimeFile, "scene.js"]);
  expect(sceneRuntimeFile).toMatch(/^scene-runtime-[a-f0-9]{16}\.js$/);
  expect(sceneCsp).toContain("script-src 'self'");
  expect(sceneCsp).toContain("sandbox allow-scripts");
  const runtime = await fetch(new URL(sceneRuntimeFile, origin + suitDetail.sceneUrl));
  expect(runtime.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  expect(await runtime.text()).toBe(sceneRuntimeScript);
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

test("every Suit ace ships passes every check the daemon runs before one applies", async () => {
  await rm(root, { recursive: true, force: true });
  const seeded = await seedBuiltinSuits(root);
  expect(seeded).toEqual(["blueprint", "neon-district", "phosphor", "starfield", "warm-paper"]);
  for (const id of seeded) {
    const checked = await library.validate(id);
    expect(checked.op === "validate" && [id, checked.summary.problems]).toEqual([id, []]);
  }
  // The scene Suit is served with its scene; the colours-only one has none.
  expect(detail(await library.read("starfield")).sceneUrl).toMatch(/scene\.html$/);
  expect(detail(await library.read("neon-district")).sceneUrl).toMatch(/scene\.html$/);
  expect(detail(await library.read("phosphor")).sceneUrl).toMatch(/scene\.html$/);
  expect(detail(await library.read("warm-paper")).sceneUrl).toBeNull();
  expect(detail(await library.read("blueprint")).sceneUrl).toBeNull();
});

test("a Suit without a scene serves no scene page and no runtime", async () => {
  await suit("plain", { "suit.json": manifest("plain") });
  await suit("neon", { "suit.json": manifest("neon"), "scene.js": "one()" });
  const neon = detail(await library.read("neon")).sceneUrl ?? "";
  // The same grant shape for a Suit with no scene.js: nothing to serve.
  const plain = await library.read("plain");
  expect(detail(plain).sceneUrl).toBeNull();
  const base = library.urls.base("plain", detail(plain).summary.contentHash);
  expect((await fetch(origin + base + "scene.html")).status).toBe(404);
  expect((await fetch(origin + base + sceneRuntimeFile)).status).toBe(404);
  expect((await fetch(new URL(sceneRuntimeFile, origin + neon))).status).toBe(200);
});

test("suit.css is served sanitised, its refusals block the Suit, and an edit re-runs the checks", async () => {
  await suit("neon", {
    "suit.json": manifest("neon"),
    "suit.css": `[data-part=sidebar] { background: url(assets/bg.png) }\n`,
    "assets/bg.png": "png",
  });
  const read = detail(await library.read("neon"));
  expect(read.summary.problems).toEqual([]);
  const base = library.urls.base("neon", read.summary.contentHash);
  expect(read.css).toBe(
    `[data-suit="neon"] [data-part=sidebar]{background:url(${base}assets/bg.png)}`,
  );
  // The raw file is never served: only the sanitised text reaches a client.
  expect((await fetch(origin + base + "suit.css")).status).toBe(404);
  expect((await fetch(origin + base + "assets/bg.png")).status).toBe(200);

  const heard: SuitSummary[][] = [];
  library.subscribe((suits) => heard.push(suits));
  await writeFile(
    join(root, "neon", "suit.css"),
    `[data-part=sidebar] { color: red }\n.sidebar { color: blue }\n`,
  );
  await vi.waitFor(
    () =>
      expect(heard.at(-1)?.[0]?.problems).toEqual([
        expect.objectContaining({ check: "css", field: "suit.css", line: 2 }),
      ]),
    { timeout: 3000 },
  );
  expect(detail(await library.read("neon")).css).toBe(
    `[data-suit="neon"] [data-part=sidebar]{color:red}`,
  );
});

test("each region's scene gets its own sandbox page, and scene.js alone stays the app's", async () => {
  await suit("neon", {
    "suit.json": manifest("neon", { scenes: { sidebar: "rain.js", composer: "glow.js" } }),
    "scene.js": "app()",
    "rain.js": "rain()",
    "glow.js": "glow()",
  });
  const { sceneUrl, sceneUrls } = detail(await library.read("neon"));
  expect(Object.keys(sceneUrls).toSorted()).toEqual(["app", "composer", "sidebar"]);
  expect(sceneUrls.app).toBe(sceneUrl);
  const page = await fetch(origin + sceneUrls.sidebar);
  expect(page.headers.get("content-security-policy")).toBe(sceneCsp);
  const scripts = [...(await page.text()).matchAll(/<script src="([^"]+)"><\/script>/g)].map(
    (match) => match[1],
  );
  expect(scripts).toEqual([sceneRuntimeFile, "rain.js"]);
  expect(await (await fetch(new URL("rain.js", origin + sceneUrls.sidebar))).text()).toBe("rain()");
  // A page for a script the Suit doesn't have serves nothing.
  expect((await fetch(new URL("header.html", origin + sceneUrls.sidebar))).status).toBe(404);
});

test("a region scene alone runs with the runtime beside it; a missing one is a problem", async () => {
  await suit("neon", {
    "suit.json": manifest("neon", { scenes: { header: "strip.js", sidebar: "gone.js" } }),
    "strip.js": "strip()",
  });
  const checked = await library.validate("neon");
  expect(checked.op === "validate" && checked.summary.problems).toEqual([
    expect.objectContaining({ check: "scene", field: "scenes.sidebar" }),
  ]);
  const read = detail(await library.read("neon"));
  expect(read.sceneUrl).toBeNull();
  expect(Object.keys(read.sceneUrls)).toEqual(["header"]);
  expect((await fetch(new URL(sceneRuntimeFile, origin + read.sceneUrls.header))).status).toBe(200);
});

test("a read serves each slot's ornament sanitised, with asset references as served URLs", async () => {
  await suit("neon", {
    "suit.json": manifest("neon", {
      ornaments: [{ slot: "sidebar-footer", asset: "assets/plate.svg" }],
    }),
    "assets/plate.svg": `<svg><image href="stamp.png"/><script>steal()</script></svg>`,
    "assets/stamp.png": "png",
  });
  const read = detail(await library.read("neon"));
  expect(read.ornaments["sidebar-footer"]).toBe(
    `<svg><image href="${read.assets["assets/stamp.png"]}"></image></svg>`,
  );
  expect(read.summary.problems).toEqual([
    expect.objectContaining({ check: "ornament", field: "assets/plate.svg", line: 1 }),
  ]);
});
