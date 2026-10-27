import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { cleanups, executablePath, setup } from "./parity-test-support.ts";
import { ref } from "./test-support.ts";

/*
 * Windows file names through ace's Chrome: non-ASCII letters, and the `%` and `!` that cmd.exe
 * and environment expansion would rewrite, survive an agent's upload and a download into the
 * person's chosen folder.
 */

const name = "résumé 雪 %USERNAME% !PATH! ü.txt";

async function page() {
  const server = createServer((request, response) => {
    if (request.url === "/report") {
      response.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="report.txt"; filename*=UTF-8''${encodeURIComponent(name)}`,
      });
      response.end("report 雪");
      return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><meta charset="utf-8"><body>
      <input type="file" aria-label="File">
      <a href="/report">Report</a>
      <div id="out"></div>
      <script>document.querySelector('input').addEventListener('change', async (event) => {
        const file = event.target.files[0];
        document.getElementById('out').textContent = file.name + ': ' + await file.text();
      });</script></body>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  return `http://127.0.0.1:${address.port}/`;
}

it.runIf(process.platform === "win32" && executablePath)(
  "Windows: a Unicode file name with % and ! uploads from the workspace and downloads to the chosen folder unchanged",
  async () => {
    const chosen = await mkdtemp(join(tmpdir(), "ace-chosen-雪-"));
    cleanups.push(() => rm(chosen, { recursive: true, force: true }));
    const f = await setup({ downloadFolder: async () => chosen });
    await f.execute({ action: "navigate", url: await page() });
    await writeFile(join(f.home, name), "upload 雪");
    const snapshot = await f.execute({ action: "snapshot" });
    await f.execute({ action: "upload", ref: ref(snapshot, "File"), files: [name] });
    await expect
      .poll(() => f.evaluate("document.getElementById('out').textContent"), { timeout: 10_000 })
      .toBe(`${name}: upload 雪`);

    await f.execute({ action: "click", ref: ref(snapshot, "Report") });
    await f.until(() => f.service.downloadsList("thread")[0]?.state === "complete");
    expect(await readdir(chosen)).toEqual([name]);
    expect(f.service.downloadsList("thread")[0]?.path).toBe(join(chosen, name));
    expect(await readFile(join(chosen, name), "utf8")).toBe("report 雪");
  },
  60_000,
);
