import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { startPreview } from "./preview-server.ts";

it("concurrent performance previews serve their own output and release their listeners", async () => {
  const roots: string[] = [];
  const servers: Awaited<ReturnType<typeof startPreview>>[] = [];
  onTestFinished(async () => {
    await Promise.all(servers.map((server) => server.close()));
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });
  for (const name of ["first performance run", "second performance run"]) {
    const root = await mkdtemp(join(tmpdir(), "ace-perf-preview-"));
    roots.push(root);
    await writeFile(join(root, "index.html"), `<p>${name}</p>`);
    servers.push(await startPreview(root, root));
  }
  const [first, second] = servers;
  if (!first || !second) throw new Error("Preview setup did not complete");
  expect(await (await fetch(first.origin)).text()).toContain("first performance run");
  expect(await (await fetch(second.origin)).text()).toContain("second performance run");
  await first.close();
  await expect(fetch(first.origin)).rejects.toThrow();
  expect(await (await fetch(second.origin)).text()).toContain("second performance run");
});

it("a preview keeps built assets for good and asks for the page again, as ace's own server does", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-perf-preview-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "index.html"), "<p>app</p>");
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "assets", "app-Ab12Cd34.js"), "export const app = 1;");
  const server = await startPreview(root, root);
  onTestFinished(() => server.close());

  const asset = await fetch(`${server.origin}/assets/app-Ab12Cd34.js`);
  expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(asset.headers.get("content-type")).toContain("text/javascript");
  expect(await asset.text()).toBe("export const app = 1;");

  const page = await fetch(server.origin);
  expect(page.headers.get("cache-control")).toBe("no-cache");
  expect(await page.text()).toContain("app");
  expect(
    (await fetch(`${server.origin}/assets/missing-Zz99Yy88.js`)).headers.get("cache-control"),
  ).not.toContain("immutable");
});
