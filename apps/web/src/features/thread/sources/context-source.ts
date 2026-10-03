// TODO(train-2): wire to protocol when merged. `context.request` (mention.complete,
// upload.begin/chunk/commit) is in @ace/protocol, but @ace/client has no request API for it yet,
// and file transfer (#44) is not on main.
import type { Attachment } from "@ace/protocol";
import type { ThreadRef } from "./workspace-source.ts";

export interface ContextSource {
  /** Paths in the thread's checkout matching `query`, best first. */
  complete(thread: ThreadRef, query: string, signal: AbortSignal): Promise<readonly string[]>;
  /** Upload a file or image into the thread's context. `progress` is 0..1. */
  upload(thread: ThreadRef, file: File, progress: (fraction: number) => void): Promise<Attachment>;
}

const files: Record<string, readonly string[]> = {
  relay: [
    "apps/server/src/replay.ts",
    "apps/server/src/cursor.ts",
    "apps/server/src/resume.ts",
    "apps/server/src/replay.spec.ts",
    "apps/web/src/relay/outbox.ts",
    "apps/web/src/relay/socket.ts",
    "apps/mobile/src/resume.ts",
    "packages/protocol/src/events.ts",
    "README.md",
    "package.json",
  ],
};
const fallback = [
  "src/index.ts",
  "src/app.tsx",
  "src/routes/index.tsx",
  "src/lib/fetch.ts",
  "src/checkout/payment-poller.ts",
  "src/checkout/checkout.spec.ts",
  "package.json",
  "README.md",
];

/** Subsequence match on the path, preferring hits in the file name. */
export function rankPaths(paths: readonly string[], query: string): string[] {
  const q = query.toLowerCase();
  const scored: { path: string; score: number }[] = [];
  for (const path of paths) {
    const lower = path.toLowerCase();
    let at = 0;
    for (const char of q) {
      at = lower.indexOf(char, at);
      if (at < 0) break;
      at++;
    }
    if (at < 0) continue;
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    scored.push({ path, score: (name.includes(q) ? 0 : 1) * 1000 + path.length });
  }
  return scored.toSorted((a, b) => a.score - b.score).map((entry) => entry.path);
}

async function sha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Realistic checkouts and an upload that reports progress, for dev:fake and tests. */
export function fakeContextSource(): ContextSource {
  return {
    complete: (thread, query, signal) => {
      if (signal.aborted) return Promise.reject(signal.reason);
      return Promise.resolve(rankPaths(files[thread.workspaceId] ?? fallback, query).slice(0, 8));
    },
    upload: async (_thread, file, progress) => {
      progress(0.5);
      const attachment: Attachment = {
        sha256: await sha256(file),
        bytes: file.size,
        mimeType: file.type || "application/octet-stream",
        name: file.name.slice(0, 255) || "file",
      };
      progress(1);
      return attachment;
    },
  };
}
