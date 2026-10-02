import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { GitWorkspace, UploadStore, resolveMentions, projectAttachments } from "../src/index.ts";

const run = promisify(execFile);
const root = await realpath(await mkdtemp(join(tmpdir(), "ace-context-bench-")));
let store: UploadStore | undefined;
try {
  await run("git", ["init", "--quiet", root]);
  for (let i = 0; i < 500; i++) await mkdir(join(root, `package-${i}`));
  let next = 0;
  await Promise.all(
    Array.from({ length: 64 }, async () => {
      while (next < 50_000) {
        const i = next++;
        await writeFile(
          join(root, `package-${Math.floor(i / 100)}`, `component-${i}.ts`),
          "export const value = 42;\n",
        );
      }
    }),
  );
  const workspace = new GitWorkspace(root);
  let start = performance.now();
  await workspace.initialize();
  const indexMs = performance.now() - start;
  const queries = ["pc19999", "component42", "p1c", "pkg", "", "component-49999"];
  const samples: number[] = [];
  for (let i = 0; i < 600; i++) {
    start = performance.now();
    workspace.index.complete(queries[i % queries.length] ?? "", 20);
    samples.push((performance.now() - start) * 1000);
  }
  samples.sort((a, b) => a - b);
  start = performance.now();
  for (let i = 0; i < 20; i++) await workspace.update([`package-${i}/component-${i * 100}.ts`]);
  const updateUs = ((performance.now() - start) * 1000) / 20;
  start = performance.now();
  for (let i = 0; i < 20; i++)
    await resolveMentions(workspace, [{ path: "package-1/component-100.ts" }]);
  const mentionUs = ((performance.now() - start) * 1000) / 20;
  store = await UploadStore.open({
    root: join(root, ".git", "context"),
    now: Date.now,
    id: randomUUID,
    authorize: () => true,
  });
  const chunk = Buffer.alloc(64 * 1024, 97),
    data = chunk.toString("base64"),
    total = 16 * 1024 * 1024;
  const digest = createHash("sha256");
  for (let offset = 0; offset < total; offset += chunk.length) digest.update(chunk);
  start = performance.now();
  const begin = await store.handle("device", {
    op: "upload.begin",
    threadId: "thread",
    sha256: digest.digest("hex"),
    bytes: total,
    name: "benchmark.txt",
  });
  if (begin.kind !== "upload") throw new Error("Expected upload response");
  for (let offset = 0; offset < total; offset += chunk.length)
    await store.handle("device", { op: "upload.chunk", uploadId: begin.uploadId, offset, data });
  await store.handle("device", { op: "upload.commit", uploadId: begin.uploadId });
  const uploadMiBs = 16 / ((performance.now() - start) / 1000);
  const prepared = Array.from({ length: 64 }, () => ({
    path: "/repo/a.png",
    name: "a.png",
    mimeType: "image/png",
    base64: "YWJj",
  }));
  start = performance.now();
  for (let i = 0; i < 2000; i++)
    projectAttachments(prepared, {
      provider: "claude",
      images: ["image/png"],
      documents: [],
      embeddedContext: false,
      maxInlineBytes: 1000,
    });
  const projectionUs = ((performance.now() - start) * 1000) / 2000;
  await store.handle("device", {
    op: "attachment.release",
    threadId: "thread",
    sha256: createHash("sha256").update(Buffer.alloc(total, 97)).digest("hex"),
  });
  start = performance.now();
  await store.collect();
  const gcMs = performance.now() - start;
  console.log(
    JSON.stringify(
      {
        files: 50_000,
        indexMs,
        completionMedianUs: samples[Math.floor(samples.length / 2)],
        completionP95Us: samples[Math.floor(samples.length * 0.95)],
        updateUs,
        mentionUs,
        uploadMiBs,
        projection64Us: projectionUs,
        gcMs,
        peakRssMiB: process.resourceUsage().maxRSS / 1024,
      },
      null,
      2,
    ),
  );
} finally {
  await store?.close();
  await rm(root, { recursive: true, force: true });
}
