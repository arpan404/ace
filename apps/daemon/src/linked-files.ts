import { createHash } from "node:crypto";
import { isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Marked, type Token } from "marked";
import { FileError, FilesService } from "@ace/files";
import type { FileOperation, ThreadId } from "@ace/protocol";
import { agentDirectory } from "./image-files.ts";
import type { ServiceContext } from "./services/types.ts";

type LinkDownload = Extract<FileOperation, { op: "link.download" }>;

// The web lexes prose with GFM on; reading links the same way keeps both sides in agreement.
const markdown = new Marked({ gfm: true, breaks: false });

/** Every link and image target in `text`, exactly as marked reads them. */
export function markdownTargets(text: string): Set<string> {
  const targets = new Set<string>();
  markdown.walkTokens(markdown.lexer(text), (token: Token) => {
    if (token.type === "link" || token.type === "image") targets.add(token.href);
  });
  return targets;
}

/** The local path a link target names: a `file:` URL or a path, without a `:line:col` suffix. */
export function localReference(reference: string): string | undefined {
  if (reference.includes("\0")) return;
  if (reference.startsWith("file:")) {
    try {
      const url = new URL(reference);
      return url.host && url.host !== "localhost" ? undefined : fileURLToPath(url);
    } catch {
      return;
    }
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(reference)) return;
  const path = reference.replace(/:\d+(?::\d+)?$/, "");
  return path || undefined;
}

/**
 * Read-only downloads of local files that an assistant message links to, wherever they are on
 * this machine. The message is the evidence: a request names the message and the link target
 * it wrote, never a path of its own choosing. Files are streamed from where they are; nothing
 * is copied.
 */
export class LinkedFiles {
  private readonly context: Pick<ServiceContext, "config" | "store" | "now" | "id">;
  private readonly services = new Map<string, Promise<FilesService>>();
  private closed = false;
  constructor(context: Pick<ServiceContext, "config" | "store" | "now" | "id">) {
    this.context = context;
  }
  /** `readable` is the caller's live grant to read the thread. */
  async bind(
    threadId: ThreadId,
    operation: LinkDownload,
    readable: () => boolean,
  ): Promise<{
    service: FilesService;
    allowed(access: "read" | "operate"): boolean;
    operation: FileOperation;
  }> {
    const { store } = this.context;
    const live = () => {
      const thread = store.getThread(threadId);
      return thread !== undefined && thread.deletedAt === undefined;
    };
    if (!readable() || !live()) throw new FileError("FORBIDDEN", "File access denied");
    const item = store.measurements.item(threadId, operation.itemId);
    if (item?.type !== "message" || item.role !== "assistant")
      throw new FileError("NOT_FOUND", "Message unavailable");
    const text = item.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n\n");
    if (!markdownTargets(text).has(operation.reference))
      throw new FileError("FORBIDDEN", "The message does not link this file");
    const local = localReference(operation.reference);
    if (!local) throw new FileError("INVALID_PATH", "The link does not name a local file");
    let path = isAbsolute(local) ? normalize(local) : undefined;
    if (!path) {
      const directory = agentDirectory(store, threadId, item.agentId);
      if (!directory) throw new FileError("NOT_FOUND", "The agent's folder is unavailable");
      path = resolve(directory, local);
    }
    const root = parse(path).root;
    const service = await this.service(root);
    return {
      service,
      allowed: (access) => access === "read" && readable() && live(),
      operation: {
        op: "download",
        path: relative(root, path).split(sep).join("/"),
        offset: operation.offset,
        ...(operation.validator === undefined ? {} : { validator: operation.validator }),
      },
    };
  }
  /** One read-only service per filesystem root (`/`, or a drive on Windows). */
  private service(root: string): Promise<FilesService> {
    if (this.closed) return Promise.reject(new FileError("CLOSED", "Linked files closed"));
    const existing = this.services.get(root);
    if (existing) return existing;
    const { config, now, id } = this.context;
    const key = createHash("sha256").update(root).digest("hex").slice(0, 16);
    const service = FilesService.create({
      workspace: root,
      dataDir: join(config.dataDir, "linked-files", key),
      now,
      id,
      authorize: (_device, capability) => capability === "files.read",
    }).catch((error: unknown) => {
      this.services.delete(root);
      throw error;
    });
    this.services.set(root, service);
    return service;
  }
  async close(): Promise<void> {
    this.closed = true;
    const all = await Promise.allSettled(this.services.values());
    await Promise.allSettled(
      all.map((result) =>
        result.status === "fulfilled" ? result.value.close() : Promise.resolve(),
      ),
    );
    this.services.clear();
  }
}
