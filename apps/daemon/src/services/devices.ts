import type { DevicesService } from "@ace/devices";
import { deviceControlDelivery } from "@ace/devices/tools";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { logFields } from "@ace/diagnostics";
import { mayCompress } from "../compression-policy.ts";
import { ThreadId, AgentId, ItemId } from "@ace/protocol";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { mkdir, realpath } from "node:fs/promises";
import type { ServiceContext } from "./types.ts";
import { LazyDevices, lazyDevices } from "../lazy-devices.ts";
import { deviceAccessRefused, devicesUnavailable } from "./device-refusals.ts";
import type { SocketContext, SocketService } from "./socket.ts";

export function startDevices(context: ServiceContext): void {
  const { resources, services, options } = context;
  const devices = options.devices
    ? LazyDevices.of(options.devices)
    : new LazyDevices(() => buildDevices(context));
  resources.own(() => devices.close());
  services.devices = devices;
}
/** The devices implementation, imported and built the first time something uses devices. */
async function buildDevices(context: ServiceContext): Promise<DevicesService> {
  const { config, services, now, id } = context;
  const directory = join(config.dataDir, "artifacts");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await realpath(directory);
  const { DevicesService, DevicePlatform, renderDeviceVideo, consumeDeviceRecording } =
    await import("@ace/devices");
  return new DevicesService({
    platform: new DevicePlatform({
      platform: process.platform,
      arch: process.arch,
      home: homedir(),
      env: process.env,
      toolsDirectory: join(config.dataDir, "tools"),
      node: process.execPath,
      // The screen helper encodes Android emulators' pictures on the Mac (`--encode-frames`).
      ...(process.platform === "darwin" && config.screenHelper
        ? { frameEncoder: config.screenHelper }
        : {}),
      // Read at each boot, so a change in Settings applies to the next emulator ace starts.
      emulatorWindow: async () =>
        (await services.settings?.get("devices.emulatorWindow"))?.value === true,
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
      return consumeDeviceRecording(artifact, async () => {
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
        await context.store.write(() =>
          context.store.appendEvents(ThreadId.parse(threadId), [
            {
              type: "item.created",
              item: {
                type: "artifact",
                source: "device",
                artifactId: artifact.id,
                id: ItemId.parse(id()),
                createdAt: now(),
                complete: true,
                filename: "Device recording.mp4",
                path: video.path,
                mimeType: video.mimeType,
                bytes: video.bytes,
              },
            },
          ]),
        );
        return video;
      });
    },
  });
}
export function createDevicesSession(context: SocketContext): SocketService {
  let channel: ReturnType<typeof import("@ace/devices").connectDevices> | undefined;
  let stopWaiting: (() => void) | undefined;
  let closed = false;
  const delivery = deviceControlDelivery({
    bufferedBytes: () => context.socket.bufferedAmount,
    after(ms, run) {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    failure: () => context.socket.close(),
    async write(message) {
      if (!context.connected() || !context.authorize("admin"))
        throw new Error("Device socket revoked");
      await new Promise<void>((resolve, reject) =>
        context.socket.send(
          JSON.stringify(message),
          { compress: mayCompress(message.type) },
          (error) => (error ? reject(error) : resolve()),
        ),
      );
    },
  });
  return {
    authenticated(kind) {
      if (kind !== undefined && kind !== "devices") return;
      const devices = context.options.devices && lazyDevices(context.options.devices);
      if (!devices || !context.authorize("admin")) return;
      const loaded = devices.current();
      if (loaded) {
        stopWaiting = () => {};
        // Opened before welcome, so a full subscriber budget refuses this socket as over limit.
        return open(loaded);
      }
      // The channel opens once the devices service exists; until then there is nothing to show.
      stopWaiting = devices.whenLoaded((service) => {
        open(service).catch((error: unknown) => {
          context.options.log?.(error);
          // Too late to refuse the hello: close as over limit, so the client retries with backoff.
          if (error instanceof Error && "code" in error && error.code === "limit")
            context.socket.close(4013, "connection_limit");
        });
      });
    },
    close() {
      closed = true;
      stopWaiting?.();
      delivery.close();
      channel?.close();
    },
    handle(message) {
      if (message.type === "devices.ack") {
        // Fire and forget: a stale or refused ack only leaves that viewer's window as it was.
        try {
          if (context.authorize("admin")) channel?.ack(message);
        } catch (error) {
          context.options.log?.(error);
        }
        return true;
      }
      if (message.type !== "devices.request") return false;
      const refuse = (error: import("@ace/protocol").DeviceFailure) =>
        context.send({ type: "devices.result", requestId: message.requestId, ok: false, error });
      const devices = context.options.devices && lazyDevices(context.options.devices);
      if (!context.authorize("admin")) refuse(deviceAccessRefused);
      else if (!devices || !stopWaiting) refuse(devicesUnavailable);
      else {
        const task = devices
          .load()
          .then(async (service) => {
            await open(service);
            if (!channel) throw new Error("Devices channel closed");
            await channel.request(message);
          })
          .catch(async (error: unknown) => {
            context.options.log?.(error);
            const { deviceFailure } = await import("@ace/devices");
            refuse(deviceFailure(error));
          })
          .finally(() => context.tasks.delete(task));
        context.tasks.add(task);
      }
      return true;
    },
  };
  async function open(service: DevicesService): Promise<void> {
    if (channel || closed || !context.connected() || !context.authorize("admin")) return;
    const { connectDevices } = await import("@ace/devices");
    if (channel || closed) return;
    channel = connectDevices(service, context.sessionId, {
      authorize: () => context.connected() && context.authorize("admin"),
      canReadThread: (threadId) => context.canReadThread(ThreadId.parse(threadId)),
      agentExists: (threadId, agentId) =>
        context.options.store.getMcpAgent(ThreadId.parse(threadId), AgentId.parse(agentId)) !==
        undefined,
      send: delivery.send,
      media: {
        bufferedBytes: () => context.socket.bufferedAmount,
        write: (piece) =>
          new Promise<void>((resolve, reject) => {
            if (!context.connected() || !context.authorize("admin"))
              return reject(new Error("Device socket revoked"));
            context.socket.send(piece, { binary: true, compress: false }, (error) =>
              error ? reject(error) : resolve(),
            );
          }),
      },
    });
  }
}
