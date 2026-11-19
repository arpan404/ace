import { checkMutations } from "./mutations.ts";

const cases = [
  {
    name: "Accept projection padding bits",
    file: "base64.ts",
    before: "(last & (padding === 2 ? 15 : 3)) === 0",
    after: "true",
    test: "projection.test.ts",
    behavior: "noncanonical padding bits",
  },
  {
    name: "Accept VP8L version bits",
    file: "image-container.ts",
    before: "frame.readUInt32LE(1) >>> 29 === 0",
    after: "true",
    test: "uploads.test.ts",
    behavior: "lossless version bits",
  },
  {
    name: "Mask cancelled partial Git frames",
    file: "git-process.ts",
    before: "throw failure ?? error;",
    after: "throw error;",
    test: "workspace-review.test.ts",
    behavior: "cancelling an incomplete Git listing",
  },
  {
    name: "Omit delivered message context",
    file: "delivery.ts",
    before: "payload.context ??",
    after: "undefined ??",
    test: "delivery.test.ts",
    behavior: "thread send delivers native context",
  },
  {
    name: "Release before consumption",
    file: "delivery.ts",
    before: "await consume({",
    after: "prepared.release(); await consume({",
    test: "delivery.test.ts",
    behavior: "thread send delivers native context",
  },
  {
    name: "Omit consumer failure release",
    file: "delivery.ts",
    before: "prepared.release();",
    after: "void prepared;",
    test: "delivery.test.ts",
    behavior: "failed provider consumer",
  },
  {
    name: "GC ignores leases",
    file: "maintenance.ts",
    before: "AND NOT EXISTS(SELECT 1 FROM leases WHERE leases.sha256=blobs.sha256)",
    after: "",
    test: "delivery.test.ts",
    behavior: "thread send delivers native context",
  },
  {
    name: "Suppress lease release",
    file: "blob-leases.ts",
    before: "if (released || this.closed) return;",
    after: "return;",
    test: "service.test.ts",
    behavior: "provider consumption retains",
  },
  {
    name: "Omit preparation failure cleanup",
    file: "service.ts",
    before: "lease.release();\n      throw error;",
    after: "throw error;",
    test: "service.test.ts",
    behavior: "failed preparation releases",
  },
  {
    name: "Release caller-mutated hashes",
    file: "blob-leases.ts",
    before: "for (const hash of hashes) {",
    after: "for (const hash of blobs.map((blob) => blob.attachment.sha256)) {",
    test: "service.test.ts",
    behavior: "caller edits to a leased descriptor",
  },
  {
    name: "Accept mismatching WebP frames",
    file: "image-container.ts",
    before: "width === canvas.width && height === canvas.height",
    after: "true",
    test: "uploads.test.ts",
    behavior: "WebP frame dimensions",
  },
];

// The path index, its watcher cache and its retries moved to ace-files; their mutations are bench
// cases inside native/files now, not TypeScript ones here.
const filter = process.argv[2];
await checkMutations(cases.filter((mutation) => !filter || new RegExp(filter).test(mutation.name)));
