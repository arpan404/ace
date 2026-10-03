import { FilesService, attachFilesSocket } from "@ace/files";
import { mkdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { daemonArtifacts } from "../files-artifacts.ts";
import { supportBundleWriter } from "../files-support.ts";
import { loadHostId } from "../local-files.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";
export async function startFiles(owner: ServiceContext): Promise<void> {
  const { config, store, now, id, log, resources, services } = owner;
  const context = { home: homedir(), env: process.env };
  let files: FilesService | undefined;
  let artifacts: ReturnType<typeof daemonArtifacts> | undefined;
  let maintenance: ReturnType<typeof setInterval> | undefined;
  if (config.relayUrl && !config.workspaceRoot)
    throw new Error("Relay files require ACE_WORKSPACE_ROOT");
  if (config.workspaceRoot) {
    const eventStore = store;
    const workspaceRoot = await realpath(config.workspaceRoot);
    const workspaceId = store.createWorkspace(workspaceRoot, basename(workspaceRoot));
    const artifactsDirectory = join(config.dataDir, "artifacts");
    await mkdir(artifactsDirectory, { recursive: true, mode: 0o700 });
    const artifactsRoot = await realpath(artifactsDirectory);
    files = await FilesService.create({
      workspace: workspaceRoot,
      dataDir: join(config.dataDir, "files"),
      artifactRoots: [artifactsRoot],
      now: now,
      id: id,
      // Socket-scoped read/operate checks are enforced by the authenticated server.
      authorize: () => true,
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
    resources.own(() => filesService.close());
    const filesService = files;
    services.files = filesService;
    await files.sweep();
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
    await artifacts.support(loadHostId(config.dataDir));
    resources.own(() => artifactsService.close());
    const artifactsService = artifacts;
    const ownedFiles = files;
    maintenance = setInterval(() => {
      void ownedFiles
        .sweep()
        .catch((error: unknown) => log.log("error", "File retention failed", error));
    }, 60_000);
    maintenance.unref();
    const timer = maintenance;
    resources.own(() => clearInterval(timer));
  }
}
export function createFilesSession(context: SocketContext): SocketService {
  let channel: ReturnType<typeof attachFilesSocket> | undefined;
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
    },
    binary(frame) {
      const active = getChannel();
      if (!active) return false;
      active.binary(frame);
      return true;
    },
    handle(message) {
      if (!message.type.startsWith("files.")) return false;
      const active = getChannel();
      if (active) active.accept(message);
      else context.fail("files_unavailable", "File service unavailable");
      return true;
    },
  };
}
