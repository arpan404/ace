import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { FileError, FilesService } from "@ace/files";
import type { FileOperation, ThreadId } from "@ace/protocol";
import {
  codeFileReference,
  fileTextSpans,
  isHomePath,
  isMachinePath,
} from "@ace/ui-core/file-references";
import { agentDirectory } from "./image-files.ts";
import type { ServiceContext } from "./services/types.ts";

type LinkDownload = Extract<FileOperation, { op: "link.download" }>;

/**
 * Spans whose text never links a file by its wording (math too, by prefix): inline code is read
 * on its own below, the rest never, as the page skips code, links and math.
 */
const notProse = new Set([
  "code",
  "code_block",
  "code_metadata",
  "syntax",
  "link",
  "image",
  "reference",
]);

/**
 * What an answer lets a reader open, read as the web renders it: markit parses the answer in
 * the flavour answers render with (loaded on the first linked download, the only time the daemon
 * reads Markdown), then ace's own rules pick file paths, as \`file-links.ts\` does on the page.
 * Granted are every link and image target (as written and as the page decodes a local one),
 * every file reference markit draws, every absolute or home path an inline code span names
 * (\`~/Downloads/My Report.pdf\`), and every one running text names.
 */
export async function linkedReferences(text: string): Promise<Set<string>> {
  const { markitDocument } = await import("@ace/markit-web/document");
  const document = await markitDocument(text, "agent");
  const references = new Set<string>();
  const cuts = new Set([0, document.text.length]);
  const excluded: [number, number][] = [];
  for (const span of document.spans) {
    cuts.add(span.start).add(span.end);
    if (notProse.has(span.kind) || span.kind.startsWith("math"))
      excluded.push([span.start, span.end]);
    if ((span.kind === "link" || span.kind === "image") && span.url) {
      references.add(span.url);
      const decoded = decodedLink(span.url);
      if (decoded) references.add(decoded);
    }
    if (span.kind === "reference" && span.reference_kind === "file" && span.target)
      references.add(span.target);
    if (span.kind === "code") {
      const found = codeFileReference(document.text.slice(span.start, span.end));
      if (found && isMachinePath(found.path)) references.add(found.path);
    }
  }
  // Running text, cut where any span starts or ends, as the page's text nodes are.
  const bounds = [...cuts].toSorted((a, b) => a - b);
  for (let index = 1; index < bounds.length; index++) {
    const from = bounds[index - 1] ?? 0;
    const to = bounds[index] ?? 0;
    if (to <= from || excluded.some(([start, end]) => start <= from && to <= end)) continue;
    for (const span of fileTextSpans(document.text.slice(from, to)))
      if (span.kind === "file" && isMachinePath(span.reference.path))
        references.add(span.reference.path);
  }
  return references;
}

/** A link target as the page opens a local one: markit percent-encodes, the page decodes. */
function decodedLink(url: string): string | undefined {
  try {
    const decoded = decodeURI(url);
    return decoded === url ? undefined : decoded;
  } catch {
    return undefined;
  }
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
  // A drive letter (`C:\a.pdf`) reads like a URL scheme but names a path.
  if (!/^[A-Za-z]:[\\/]/.test(reference) && /^[a-z][a-z\d+.-]*:/i.test(reference)) return;
  const path = reference.replace(/:\d+(?::\d+)?$/, "");
  return path || undefined;
}

/**
 * Read-only downloads of local files that an assistant message links to or names by absolute
 * path, wherever they are on this machine. The message is the evidence: a request names the
 * message and the target it wrote, never a path of its own choosing. Files are streamed from where they are; nothing
 * is copied.
 */
export class LinkedFiles {
  private readonly context: Pick<ServiceContext, "config" | "store" | "now" | "id">;
  /** Where a `~/` path starts. */
  private readonly home: string;
  private readonly services = new Map<string, Promise<FilesService>>();
  private closed = false;
  constructor(
    context: Pick<ServiceContext, "config" | "store" | "now" | "id">,
    home: string = homedir(),
  ) {
    this.context = context;
    this.home = home;
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
    if (!(await linkedReferences(text)).has(operation.reference))
      throw new FileError("FORBIDDEN", "The message does not link this file");
    const local = localReference(operation.reference);
    if (!local) throw new FileError("INVALID_PATH", "The link does not name a local file");
    let path = isHomePath(local)
      ? resolve(this.home, local.slice(2))
      : isAbsolute(local)
        ? normalize(local)
        : undefined;
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
