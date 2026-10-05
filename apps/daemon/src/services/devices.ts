import { DevicesService, DevicePlatform, connectDevices, renderDeviceVideo } from "@ace/devices";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { logFields } from "@ace/diagnostics";
import { ThreadId, AgentId } from "@ace/protocol";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { mkdir, realpath, unlink } from "node:fs/promises";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";

export async function startDevices(context: ServiceContext): Promise<void> {
  const { config, resources, services, now, id, options } = context;
  const directory = join(config.dataDir, "artifacts");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await realpath(directory);
  const service =
    options.devices ??
    new DevicesService({
      platform: new DevicePlatform({
        platform: process.platform,
        home: homedir(),
        env: process.env,
        ...(services.screen ? { screen: services.screen } : {}),
      }),
      runtime: {
        now,
        id,
        spawn: spawnRawSupervised,
        after(ms, run) {
          const timer = setTimeout(run, ms);
          return () => clearTimeout(timer);
        },
      },
      env: process.env,
      ...(services.screen ? { screen: services.screen } : {}),
      log: (level, message, fields) =>
        context.log.log(
          level,
          message,
          logFields(Object.entries(fields).filter(([, value]) => value !== undefined)),
        ),
      recordingDirectory: root,
      recordingAvailable: () => services.files !== undefined,
      async publishArtifact(artifact, threadId) {
        if (!context.store.getThread(ThreadId.parse(threadId)))
          throw new Error("Recording thread no longer exists");
        if (!services.files)
          throw new Error("Configure ACE_WORKSPACE_ROOT to publish device artifacts");
        const video = await renderDeviceVideo(artifact, process.env);
        await services.files.registerArtifact({
          root,
          path: basename(video.path),
          name: `${artifact.id}.mp4`,
          category: "recording",
          id: artifact.id,
        });
        await unlink(artifact.path);
        return video;
      },
    });
  resources.own(() => service.close());
  services.devices = service;
}
export function createDevicesSession(context: SocketContext): SocketService {
  let channel: ReturnType<typeof connectDevices> | undefined;
  return {
    authenticated(kind) {
      if (kind !== undefined && kind !== "devices") return;
      const service = context.options.devices;
      if (!service || !context.authorize("admin")) return;
      channel = connectDevices(service, context.sessionId, {
        authorize: () => context.connected() && context.authorize("admin"),
        canReadThread: (threadId) => context.canReadThread(ThreadId.parse(threadId)),
        agentExists: (threadId, agentId) =>
          context.options.store.getMcpAgent(ThreadId.parse(threadId), AgentId.parse(agentId)) !==
          undefined,
        async send(message) {
          if (!context.connected() || !context.authorize("admin"))
            throw new Error("Device socket revoked");
          if (context.socket.bufferedAmount > 256 * 1024) {
            context.socket.close(4009, "Device control backpressure");
            throw new Error("Device control backpressure");
          }
          await new Promise<void>((resolve, reject) =>
            context.socket.send(JSON.stringify(message), (error) =>
              error ? reject(error) : resolve(),
            ),
          );
        },
        frame(packet) {
          return new Promise<void>((resolve, reject) => {
            if (!context.connected() || !context.authorize("admin")) {
              reject(new Error("Device socket revoked"));
              return;
            }
            if (context.socket.bufferedAmount > 8 * 1024 * 1024) {
              context.socket.close(4009, "Device backpressure");
              reject(new Error("Device backpressure"));
              return;
            }
            context.socket.send(packet, { binary: true }, (error) =>
              error ? reject(error) : resolve(),
            );
          });
        },
      });
    },
    close() {
      channel?.close();
    },
    handle(message) {
      if (message.type !== "devices.request") return false;
      if (!channel || !context.authorize("admin"))
        context.fail("forbidden", "Admin scope is required for device access");
      else {
        const task = channel
          .request(message)
          .catch((error: unknown) => {
            context.options.log?.(error);
            context.fail("devices_failed", "Device request failed");
          })
          .finally(() => context.tasks.delete(task));
        context.tasks.add(task);
      }
      return true;
    },
  };
}
