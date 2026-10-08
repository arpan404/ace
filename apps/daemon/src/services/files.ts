import { startSupportFiles } from "./support-files.ts";
import { logError } from "@ace/diagnostics";
import { FilesWorkspaces } from "../files-workspaces.ts";
import { warmup } from "./warmup.ts";
import { FilesService, attachFilesSocket, chunkFilesChannel } from "@ace/files";
import { mkdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { daemonArtifacts } from "../files-artifacts.ts";
import { supportBundleWriter } from "../files-support.ts";
import { loadHostId } from "../local-files.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";
export async function startFiles(owner: ServiceContext): Promise<void> {
  await startSupportFiles(owner);
  const { config, store, now, id, log, resources, services } = owner;
  const context = { home: homedir(), env: process.env };
  let files: FilesService | undefined;
  let artifacts: ReturnType<typeof daemonArtifacts> | undefined;
  const scoped = new FilesWorkspaces(owner);
  services.threadFiles = scoped;
  resources.own(() => scoped.close());
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
      onChange: (change) => eventStore.recordWorkspaceFileChange(workspaceId, change),
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
    const job = warmup(owner, "files", async () => {
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
      .catch((error: unknown) => log.log("error", "File retention failed", logError(error)))
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
  const getChunks = () => {
    const device = context.device();
    const files = context.options.threadFiles;
    if (!device) return undefined;
    chunks ??= chunkFilesChannel({
      device,
      send: context.send,
      async resolve(threadId, scope) {
        if (scope === "support") {
          const service = context.options.supportFiles;
          if (!service) throw new Error("Support export unavailable");
          return { service, allowed: (access) => context.connected() && context.authorize(access) };
        }
        if (!threadId || !files || !context.canReadThread(threadId))
          throw new Error("File thread unavailable");
        const root = files.root(threadId);
        const service = await files.get(threadId);
        return {
          service,
          allowed: (access) =>
            context.connected() &&
            context.authorize(access) &&
            context.canReadThread(threadId) &&
            files.matches(threadId, root),
        };
      },
    });
    return chunks;
  };
  const getChannel = () => {
    const device = context.device();
    if (!device || !context.options.files) return undefined;
    channel ??= attachFilesSocket(context.options.files, context.socket, device, (capability) =>
      context.authorize(capability === "files.read" ? "read" : "operate"),
    );
    return channel;
  };
  return {
    authenticated() {
      getChannel();
    },
    close() {
      channel?.close();
      chunks?.close();
    },
    binary(frame) {
      const active = getChannel();
      if (!active) return false;
      active.binary(frame);
      return true;
    },
    handle(message) {
      if (!message.type.startsWith("files.")) return false;
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
        (message.type === "files.request" && (message.threadId || message.scope === "support"))
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
