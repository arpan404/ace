import { startSupportFiles } from "./support-files.ts";
import { fileExportSource } from "../file-export-source.ts";
import { filesScope } from "../files-scope.ts";
import { listFolderPage } from "../files-tool/list-folder.ts";
import type { FolderWatchClient, FoldersChanged } from "../files-tool/folder-watch.ts";
import type { ThreadId } from "@ace/protocol";
import { FilesWorkspaces } from "../files-workspaces.ts";
import { repeatableWarmup } from "./warmup.ts";
import { backgroundFailure } from "./background.ts";
import { startFilesNative, sweepFilesRoots } from "../files-tool/wiring.ts";
import { filesErrorCode } from "../files-tool/tool.ts";
import { FilesService, attachFilesSocket, chunkFilesChannel, attachmentChannel } from "@ace/files";
import { mkdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { daemonArtifacts } from "../files-artifacts.ts";
import { supportBundleWriter } from "../files-support.ts";
import { loadHostId } from "../local-files.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketMessage, SocketService } from "./socket.ts";
export async function startFiles(owner: ServiceContext): Promise<void> {
  await startSupportFiles(owner);
  const { config, store, now, id, log, resources, services } = owner;
  const context = { home: homedir(), env: process.env };
  let files: FilesService | undefined;
  let artifacts: ReturnType<typeof daemonArtifacts> | undefined;
  const scoped = new FilesWorkspaces(owner);
  services.threadFiles = scoped;
  resources.own(() => scoped.close());
  const native = startFilesNative(owner);
  services.filesNative = native;
  resources.own(() => native.tool.close());
  resources.own(() => native.folders.close());
  const idle = setInterval(() => {
    void sweepFilesRoots(native, owner).catch(backgroundFailure(owner, "File root cleanup failed"));
  }, 60_000);
  idle.unref();
  resources.own(() => clearInterval(idle));
  if (config.workspaceRoot) {
    const eventStore = store;
    const workspaceRoot = await realpath(config.workspaceRoot);
    owner.signal.throwIfAborted();
    const workspaceId = store.createWorkspace(config.workspaceRoot, basename(workspaceRoot));
    const artifactsDirectory = join(config.dataDir, "artifacts");
    await mkdir(artifactsDirectory, { recursive: true, mode: 0o700 });
    const artifactsRoot = await realpath(artifactsDirectory);
    files = await FilesService.create({
      ...owner.options.files,
      workspace: workspaceRoot,
      dataDir: join(config.dataDir, "files"),
      artifactRoots: [artifactsRoot],
      now: now,
      id: id,
      // Socket-scoped read/operate checks are enforced by the authenticated server.
      authorize: () => !store.workspaceReservations.reserved(workspaceRoot),
      onChange: (change) =>
        eventStore.recordWorkspaceFileChange(workspaceId, workspaceRoot, change),
      onUploadRecovery: (notice) =>
        log.log("warn", "Upload receipt settled after destination changed", notice),
      exportSupport: (_device, assertAuthorized) => {
        if (!artifacts) throw new Error("Artifact producer not initialized");
        return artifacts.bundle(assertAuthorized);
      },
      exportRaw: (_device, blobRef, assertAuthorized) => {
        if (!artifacts) throw new Error("Artifact producer not initialized");
        return artifacts.raw(blobRef, assertAuthorized);
      },
      exportOutput: (_device, streamId, assertAuthorized) => {
        if (!artifacts) throw new Error("Artifact producer not initialized");
        return artifacts.output(streamId, assertAuthorized);
      },
    });
    const filesService = files;
    services.files = filesService;
    scoped.register(workspaceRoot, filesService);
    artifacts = daemonArtifacts(
      files,
      artifactsRoot,
      store,
      workspaceId,
      join(config.dataDir, "events.sqlite"),
      supportBundleWriter(
        config.dataDir,
        artifactsRoot,
        { ...context, workspace: workspaceRoot },
        now,
      ),
    );
    const artifactsService = artifacts;
    resources.own(() => artifactsService.close());
    const job = repeatableWarmup(owner, "files", async () => {
      await filesService.sweep(owner.signal);
      owner.signal.throwIfAborted();
      await artifactsService.support(loadHostId(config.dataDir));
    });
    resources.own(() => job);
  }
  let sweeping: Promise<void> | undefined;
  const maintenance = setInterval(() => {
    if (sweeping) return;
    sweeping = (async () => {
      await scoped.sweep(owner.signal);
      await services.supportFiles?.sweep(owner.signal);
    })()
      .catch(backgroundFailure(owner, "File retention failed"))
      .finally(() => {
        sweeping = undefined;
      });
  }, 60_000);
  maintenance.unref();
  resources.own(async () => {
    clearInterval(maintenance);
    await sweeping;
  });
}
export function createFilesSession(context: SocketContext): SocketService {
  let channel: ReturnType<typeof attachFilesSocket> | undefined;
  let chunks: ReturnType<typeof chunkFilesChannel> | undefined;
  let attachments: ReturnType<typeof attachmentChannel> | undefined;
  const getAttachments = () => {
    const device = context.device();
    const service = context.options.context;
    if (!device || !service?.downloadAttachment) return undefined;
    attachments ??= attachmentChannel({
      async resolve(thread, hash, maxBytes) {
        const authorized = () => {
          return (
            context.connected() &&
            context.authorize("read") &&
            context.canReadThread(thread) &&
            context.options.store.hasLiveThread(thread)
          );
        };
        if (!authorized() || !service.downloadAttachment)
          throw new Error("Thread attachment unavailable");
        const download = await service.downloadAttachment(
          device,
          thread,
          hash,
          maxBytes,
          authorized,
        );
        return { download, authorized };
      },
      async send(message) {
        context.send(message);
      },
      // Credits already bound this: each stream holds one 64 KiB frame, at most four streams.
      // Other output queued on a slow link (a phone's transcript, other images) is no reason to
      // fail the image; the write waits its turn like every reliable message.
      binary(bytes) {
        return new Promise<void>((resolve, reject) => {
          if (!context.connected()) {
            reject(new Error("Attachment channel disconnected"));
            return;
          }
          context.socket.send(bytes, { binary: true, compress: false }, (error) =>
            error ? reject(error) : resolve(),
          );
        });
      },
    });
    return attachments;
  };
  const readableSource = (source: ThreadId | undefined) =>
    source === undefined ||
    (context.canReadThread(source) && context.options.store.hasLiveThread(source));
  const threadAccess = (threadId: ThreadId) =>
    context.canReadThread(threadId) && context.options.store.hasLiveThread(threadId);
  const resolve = filesScope({
    authorize: (access) => context.authorize(access),
    threadAccess,
    connected: () => context.connected(),
    options: context.options,
  });
  const native = context.options.filesNative;
  const files = context.options.threadFiles;
  const watcher: FolderWatchClient = {
    id: context.sessionId,
    sendable: () => context.connected() && context.authorize("read"),
    valid: ({ id, root }) => threadAccess(id) && (files?.matches(id, root) ?? false),
    send: (message: FoldersChanged) => {
      if (!context.connected() || !context.authorize("read")) return;
      if (!context.canReadThread(message.threadId)) return;
      context.send(message);
    },
  };
  const getChunks = () => {
    const device = context.device();
    if (!device) return undefined;
    chunks ??= chunkFilesChannel({ device, send: context.send, resolve });
    return chunks;
  };
  const getChannel = () => {
    const device = context.device();
    if (!device || !context.options.files) return undefined;
    const service = context.options.files;
    channel ??= attachFilesSocket(
      service,
      context.socket,
      device,
      (capability, operation) =>
        context.authorize(capability === "files.read" ? "read" : "operate") &&
        readableSource(fileExportSource(service, context.options.store, operation)),
    );
    return channel;
  };
  /** Run a files task under the socket's budget, so a slow listing cannot pile up. */
  const background = (task: Promise<void>) => {
    context.tasks.add(task);
    void task.finally(() => context.tasks.delete(task));
  };
  /** At most this many folder listings run at once on one socket; more get BUSY. */
  const listingLimit = 8;
  let listings = 0;
  /** A listing's abort switch, by request id, so `files.abort` cancels it in ace-files. */
  const aborting = new Map<string, AbortController>();
  /** One folder from ace-files, authorized exactly as the old `list` is. */
  const listFolder = (message: Extract<SocketMessage, { type: "files.request" }>) => {
    const operation = message.operation;
    if (operation.op !== "list.folder") return;
    const requestId = message.requestId;
    if (listings >= listingLimit) {
      context.send({
        type: "files.error",
        requestId,
        code: "BUSY",
        message: "Folder listings are busy on this connection; try again",
      });
      return;
    }
    const controller = new AbortController();
    listings++;
    aborting.set(requestId, controller);
    background(
      (async () => {
        try {
          const page = await listFolderPage(resolve, native?.tool, {
            threadId: message.threadId,
            scope: message.scope,
            workspaceId: message.workspaceId,
            operation,
            signal: controller.signal,
          });
          context.send({ type: "files.result", requestId, value: page });
        } catch (error) {
          context.send({
            type: "files.error",
            requestId,
            code: filesErrorCode(error),
            message: error instanceof Error ? error.message : "Folder listing failed",
          });
        } finally {
          listings--;
          aborting.delete(requestId);
        }
      })(),
    );
  };
  /**
   * Replace this client's watched folders of a thread. A socket that may not read the thread, or
   * a machine without ace-files, is simply not watching: the message carries no request id, and
   * the next re-list tries again.
   */
  const watchFolders = (message: Extract<SocketMessage, { type: "files.watch" }>) => {
    const threadId = message.threadId;
    if (!context.authorize("read") || !context.canReadThread(threadId)) return;
    const folders = message.folders;
    if (!native) return;
    background(
      (async () => {
        try {
          const binding = await resolve(threadId, undefined, undefined, undefined);
          try {
            if (!binding.allowed("read") || binding.root === undefined) return;
            await native.folders.watch(watcher, threadId, binding.root, folders);
          } finally {
            binding.release?.();
          }
        } catch (error) {
          context.options.log?.(error);
        }
      })(),
    );
  };
  return {
    authenticated() {
      getChannel();
    },
    close() {
      channel?.close();
      chunks?.close();
      for (const controller of aborting.values()) controller.abort();
      aborting.clear();
      if (native) {
        const dropping = native.folders.disconnect(context.sessionId).catch(() => {});
        context.tasks.add(dropping);
        void dropping.finally(() => context.tasks.delete(dropping));
      }
      if (attachments) {
        const closing = attachments.close().catch(() => {});
        context.tasks.add(closing);
        // The close drops its own failure above; this only forgets the task.
        void closing.finally(() => context.tasks.delete(closing)).catch(() => {});
      }
    },
    binary(frame) {
      const active = getChannel();
      if (!active) return false;
      active.binary(frame);
      return true;
    },
    handle(message) {
      if (!message.type.startsWith("files.")) return false;
      if (message.type === "files.abort") aborting.get(message.sourceRequestId)?.abort();
      if (message.type === "files.watch") {
        watchFolders(message);
        return true;
      }
      if (message.type === "files.request" && message.operation.op === "list.folder") {
        listFolder(message);
        return true;
      }
      const attachment =
        message.type === "files.request" && message.operation.op === "attachment.download"
          ? getAttachments()
          : attachments;
      if (attachment?.accept(message)) return true;
      if (message.type === "files.request" && message.operation.op === "attachment.download") {
        context.send({
          type: "files.error",
          requestId: message.requestId,
          code: "NOT_FOUND",
          message: "Attachment streaming unavailable",
        });
        return true;
      }
      if (message.type === "files.request" && message.scope === "support") {
        const op = message.operation;
        // Global access exposes only the dedicated support registry, never workspace files.
        if (op.op !== "artifact.support" && op.op !== "artifact.download") {
          context.fail("forbidden", "Thread scope required", false, {
            requestId: message.requestId,
          });
          return true;
        }
        // Conversation exports cover the whole host, so paired/read-only devices cannot ask for them.
        if (
          ((op.op === "artifact.support" && op.includeThreads) ||
            (op.op === "artifact.download" && op.artifactId.startsWith("local-support-"))) &&
          !(context.local && context.canSubmitSecret?.() && context.authorize("operate"))
        ) {
          context.fail("forbidden", "Conversation export requires local access", false, {
            requestId: message.requestId,
          });
          return true;
        }
      }
      if (
        message.type === "files.abort" ||
        message.type === "files.pull" ||
        message.type === "files.chunk" ||
        (message.type === "files.request" &&
          (message.threadId || message.workspaceId || message.scope === "support"))
      ) {
        const scoped = getChunks();
        if (scoped) scoped.accept(message);
        else
          context.fail(
            "files_unavailable",
            "File service unavailable",
            false,
            "requestId" in message ? { requestId: message.requestId } : {},
          );
        return true;
      }
      if (message.type === "files.cancel" && message.channel > 0x80000000 && chunks) {
        chunks.accept(message);
        return true;
      }
      const active = getChannel();
      if (active) active.accept(message);
      else context.fail("files_unavailable", "File service unavailable");
      return true;
    },
  };
}
