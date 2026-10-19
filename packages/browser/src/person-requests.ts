import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { BrowserActionError } from "./action-error.ts";
import type { BrowserBackendTabs } from "./backend.ts";

/** One file the person picked on their device, readable once from where ace received it. */
export interface PersonFile {
  name: string;
  open(): Promise<{ chunks: AsyncIterable<Uint8Array>; close(): Promise<void> }>;
}

/**
 * What only the person asks of a page: answering a site's sign-in prompt, proceeding past a
 * certificate warning, picking files for a file input or turning a tab's sound on. These
 * arrive from a person's client connection only; no agent tool sends them, so an agent never
 * types a site password or bypasses a certificate.
 */
export type PersonRequest =
  | {
      kind: "auth";
      tabId: string;
      authId: string;
      credentials?: { username: string; password: string } | undefined;
    }
  | { kind: "certificate"; tabId: string; url: string }
  | { kind: "mute"; tabId: string; muted: boolean }
  | { kind: "files"; tabId: string; chooserId: string; files: readonly PersonFile[] };

export async function requestAsPerson(
  tabs: BrowserBackendTabs | undefined,
  request: PersonRequest,
  /** A fresh directory of the thread's browser where picked files are written. */
  staging: () => Promise<string>,
): Promise<void> {
  switch (request.kind) {
    case "auth":
      if (!tabs?.answerAuth) throw new BrowserActionError("not_supported");
      await tabs.answerAuth(request.tabId, request.authId, request.credentials);
      return;
    case "certificate":
      if (!tabs?.proceedCertificate) throw new BrowserActionError("not_supported");
      await tabs.proceedCertificate(request.tabId, request.url);
      return;
    case "mute":
      if (!tabs?.mute) throw new BrowserActionError("not_supported");
      await tabs.mute(request.tabId, request.muted);
      return;
    case "files": {
      if (!tabs?.chooseFiles) throw new BrowserActionError("not_supported");
      const paths = request.files.length ? await stage(request.files, await staging()) : [];
      await tabs.chooseFiles(request.tabId, request.chooserId, paths);
      return;
    }
  }
}

/** Writes each file under its own name (the page sees it), each in its own folder. */
export async function stage(files: readonly PersonFile[], root: string): Promise<string[]> {
  const paths: string[] = [];
  for (const [index, file] of files.entries()) {
    const folder = join(root, String(index));
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const name = basename(file.name.replaceAll("\\", "/")).replaceAll("\0", "") || "file";
    const path = join(folder, name === "." || name === ".." ? "file" : name);
    const source = await file.open();
    try {
      await pipeline(Readable.from(source.chunks), createWriteStream(path, { mode: 0o600 }));
    } finally {
      await source.close();
    }
    paths.push(path);
  }
  return paths;
}
