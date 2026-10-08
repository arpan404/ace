import type { FileOperation } from "@ace/protocol";
import type { FakeServiceContext } from "./service-context.ts";
import { checkoutFiles } from "./services/checkout-contents.ts";

export interface CheckoutFile {
  bytes: Uint8Array;
  version: string;
  folder?: boolean;
}
interface Deleted {
  id: string;
  path: string;
  root: string;
  size: number;
  version: string;
  expires: number;
  files: [string, CheckoutFile][];
}
const clean = (path: string) => path.replace(/\/+$/, "");
const inside = (path: string, base: string) => path === base || path.startsWith(`${base}/`);

/** Small, isolated fixture checkout; deletions never resurrect the seed content. */
export class FakeCheckout {
  readonly files = new Map<string, CheckoutFile>();
  readonly previews = new Map<string, { root: string; paths: string[]; versions: string[] }>();
  private roots = new Set<string>();
  private deleted = new Map<string, Deleted>();
  private sequence = 0;
  private host: FakeServiceContext;
  constructor(host: FakeServiceContext) {
    this.host = host;
  }
  key(threadId: string, path: string): string {
    const thread = this.host.thread(threadId)?.thread;
    if (!thread || thread.deletedAt !== undefined) throw new Error("NOT_FOUND");
    if (
      thread.details?.workspaceChange?.state === "preparing" ||
      thread.details?.workspaceChange?.uncertain
    )
      throw new Error("BUSY");
    if (
      path.startsWith("/") ||
      path.includes("\\") ||
      path.includes("\0") ||
      path.split("/").some((part) => part === ".." || part === "." || part === ".git")
    )
      throw new Error("OUTSIDE_WORKSPACE");
    const root = thread.details?.worktree ?? `/fake/${thread.workspaceId}`;
    if (!this.roots.has(root)) {
      this.roots.add(root);
      this.files.set(`${root}\0.cache`, {
        bytes: new Uint8Array(),
        version: this.version(),
        folder: true,
      });
      this.files.set(`${root}\0.cache/replay.log`, {
        bytes: new TextEncoder().encode("Ignored build output\n"),
        version: this.version(),
      });
      for (const [name, text] of Object.entries(checkoutFiles(thread.workspaceId))) {
        this.files.set(`${root}\0${name}`, {
          bytes: new TextEncoder().encode(text),
          version: this.version(),
        });
        const parts = name.split("/");
        parts.pop();
        while (parts.length) {
          const folder = `${root}\0${parts.join("/")}`;
          if (!this.files.has(folder))
            this.files.set(folder, {
              bytes: new Uint8Array(),
              version: this.version(),
              folder: true,
            });
          parts.pop();
        }
      }
    }
    return `${root}\0${clean(path)}`;
  }
  retainedBytes(): number {
    return (
      [...this.files.values()].reduce((size, file) => size + file.bytes.length, 0) +
      [...this.deleted.values()].reduce((size, entry) => size + entry.size, 0)
    );
  }
  version() {
    return `file-${++this.sequence}`;
  }
  paths(threadId: string, includeIgnored = false) {
    const root = this.key(threadId, "");
    return [...this.files]
      .filter(
        ([key]) =>
          key.startsWith(root) && (includeIgnored || !key.slice(root.length).startsWith(".cache")),
      )
      .map(([key, file]) => key.slice(root.length) + (file.folder ? "/" : ""))
      .toSorted();
  }
  apply(threadId: string, op: FileOperation): unknown {
    const root = this.key(threadId, "");
    if (op.op === "list") {
      const paths = this.paths(threadId).filter(
        (path) => !op.path || inside(clean(path), clean(op.path)),
      );
      return { paths: paths.slice(0, op.limit), truncated: paths.length > op.limit };
    }
    if (op.op === "trash.list") {
      const all = [...this.deleted.values()]
        .filter(
          (entry) =>
            entry.root === root &&
            entry.expires > this.host.now() &&
            (!op.after || entry.id > op.after),
        )
        .toSorted((a, b) => a.id.localeCompare(b.id));
      return {
        entries: all
          .slice(0, op.limit)
          .map(({ id, path, size, version, expires }) => ({ id, path, size, version, expires })),
        nextCursor: all.length > op.limit ? all[op.limit - 1]?.id : null,
      };
    }
    if (op.op === "archive.preview") {
      const path = clean(op.path);
      if (path && !this.files.get(root + path)?.folder) throw new Error("NOT_FOUND");
      if (this.previews.size >= 4) this.previews.delete(this.previews.keys().next().value ?? "");
      const paths = this.paths(threadId, op.includeIgnored)
        .map(clean)
        .filter((name) => !path || name.startsWith(`${path}/`));
      const previewId = this.version();
      this.previews.set(previewId, {
        root,
        paths,
        versions: paths.map((name) => this.files.get(root + name)?.version ?? ""),
      });
      return {
        previewId,
        entries: paths.length,
        bytes: paths.reduce(
          (size, name) => size + (this.files.get(root + name)?.bytes.length ?? 0),
          0,
        ),
        format: "tar.gz",
      };
    }
    if (
      !["create", "write", "mkdir", "rename", "move", "delete", "restore"].includes(op.op) ||
      !("path" in op) ||
      !("expected" in op)
    )
      throw new Error("UNSUPPORTED");
    const key = this.key(threadId, op.path);
    if (key === root) throw new Error("INVALID_PATH");
    const file = this.files.get(key);
    if ((file?.version ?? null) !== op.expected) throw new Error("CONFLICT");
    const path = clean(op.path);
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (path.includes("/") && !this.files.get(root + parent)?.folder) throw new Error("NOT_FOUND");
    const id = this.version();
    let destination: string | undefined;
    let trashId: string | undefined;
    if (op.op === "create" || op.op === "write" || op.op === "mkdir") {
      const entries =
        this.files.size +
        [...this.deleted.values()].reduce((count, entry) => count + entry.files.length, 0);
      if (!file && entries >= 4096) throw new Error("QUOTA");
      const bytes = new TextEncoder().encode(op.op === "mkdir" ? "" : op.text);
      if (bytes.length > 1024 * 1024) throw new Error("QUOTA");
      this.files.set(key, { bytes, version: id, ...(op.op === "mkdir" ? { folder: true } : {}) });
    } else if (op.op === "rename" || op.op === "move") {
      if (!file) throw new Error("NOT_FOUND");
      const dest = this.key(threadId, op.destination);
      if (this.files.has(dest) || op.destinationExpected !== null || inside(dest, key))
        throw new Error("CONFLICT");
      const destPath = clean(op.destination),
        parentPath = destPath.slice(0, destPath.lastIndexOf("/"));
      if (destPath.includes("/") && !this.files.get(root + parentPath)?.folder)
        throw new Error("NOT_FOUND");
      for (const [name, item] of Array.from(this.files).filter(([candidate]) =>
        inside(candidate, key),
      )) {
        this.files.delete(name);
        this.files.set(dest + name.slice(key.length), item);
      }
      destination = clean(op.destination);
    } else if (op.op === "delete") {
      if (!file) throw new Error("NOT_FOUND");
      const files = [...this.files].filter(([candidate]) => inside(candidate, key));
      for (const [name] of files) this.files.delete(name);
      this.deleted.set(id, {
        id,
        root,
        path,
        files,
        size: files.reduce((size, [, item]) => size + item.bytes.length, 0),
        version: file.version,
        expires: this.host.now() + 7 * 86400_000,
      });
      trashId = id;
    } else if (op.op === "restore") {
      const entry = this.deleted.get(op.trashId);
      if (!entry || entry.root !== root) throw new Error("NOT_FOUND");
      if (entry.expires <= this.host.now()) throw new Error("EXPIRED");
      for (const [name, item] of entry.files)
        this.files.set(key + name.slice((root + entry.path).length), item);
      this.deleted.delete(op.trashId);
    }
    return {
      id,
      op: op.op,
      path,
      version: this.files.get(root + (destination ?? path))?.version ?? null,
      ...(destination ? { destination } : {}),
      ...(trashId ? { trashId } : {}),
    };
  }
}
