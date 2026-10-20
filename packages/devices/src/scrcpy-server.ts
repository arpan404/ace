import { connect, type Socket } from "node:net";
import type { RawSupervisedProcess } from "@ace/provider-kit/process";
import type { DeviceRuntime } from "./runtime.ts";
import { DeviceError } from "./sdk.ts";
import { scrcpyRelease } from "./scrcpy-jar.ts";
import { scrcpyServerArgs, scrcpySocketName, type ServerProfile } from "./scrcpy-protocol.ts";

/** One adb command on the capture's own transport. */
export type AdbCommand = (
  args: readonly string[],
  maxBytes?: number,
  timeoutMs?: number,
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

export type ScrcpyConnection = {
  /** Video socket, positioned at the codec id. */
  video: Socket;
  control: Socket;
  /** Bytes the video socket delivered with the preamble, to be read before later chunks. */
  initialVideo: Buffer;
  deviceName: string;
  exited: Promise<unknown>;
  close(): Promise<void>;
};

const deviceNameBytes = 64;

/**
 * Reads `count` bytes from a forward-tunnel connection, then pauses it. adb accepts the TCP
 * connection even while nothing listens on the device, then closes it: that is `undefined`.
 */
function preamble(
  socket: Socket,
  count: number,
  runtime: DeviceRuntime,
  timeoutMs: number,
): Promise<Buffer | undefined> {
  if (count <= 0) return Promise.resolve(Buffer.alloc(0));
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const done = (value: Buffer | undefined) => {
      cancel();
      socket.off("data", data);
      socket.off("close", closed);
      socket.off("error", closed);
      resolve(value);
    };
    const data = (chunk: Buffer) => {
      chunks.push(chunk);
      length += chunk.length;
      if (length >= count) {
        socket.pause();
        done(Buffer.concat(chunks, length));
      }
    };
    const closed = () => done(undefined);
    const cancel = runtime.after(timeoutMs, () => done(undefined));
    socket.on("data", data);
    socket.once("close", closed);
    socket.once("error", closed);
    socket.resume();
  });
}

function open(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port, noDelay: true });
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

/**
 * Starts the pinned scrcpy server on one emulator and connects its video and control sockets
 * through an `adb forward` tunnel: video on, audio off, control on.
 */
export async function startScrcpyServer(options: {
  adb: string;
  serial: string;
  jar: string;
  profile: ServerProfile;
  command: AdbCommand;
  runtime: DeviceRuntime;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  startupMs?: number;
}): Promise<ScrcpyConnection> {
  const { command, runtime } = options;
  const check = () => options.signal?.throwIfAborted();
  // The server deletes its own jar (`cleanup=true`), and a stopping server may do so late, so
  // every run pushes a copy of its own.
  const remoteJar = `/data/local/tmp/ace-${scrcpySocketName(options.profile.scid)}.jar`;
  const pushed = await command(["push", options.jar, remoteJar], 64 * 1024, 60_000);
  if (pushed.code !== 0)
    throw new DeviceError(
      "command_failed",
      "Could not copy scrcpy-server to the emulator",
      "Check that the emulator has free space in /data/local/tmp.",
    );
  check();
  const name = scrcpySocketName(options.profile.scid);
  const forwarded = await command(["forward", "tcp:0", `localabstract:${name}`], 4096, 10_000);
  const port = Number(forwarded.stdout.trim());
  if (forwarded.code !== 0 || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new DeviceError(
      "command_failed",
      "adb could not forward the scrcpy socket",
      "Restart adb with `adb kill-server`, then start the device view again.",
    );
  let server: RawSupervisedProcess | undefined;
  const sockets: Socket[] = [];
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.allSettled([
        server?.stop({ graceMs: 1000 }),
        command(["forward", "--remove", `tcp:${port}`], 4096, 5000),
      ]);
    })());
  try {
    server = runtime.spawn({
      command: options.adb,
      args: [
        "-s",
        options.serial,
        "shell",
        [
          `CLASSPATH=${remoteJar}`,
          "app_process",
          "/",
          "com.genymobile.scrcpy.Server",
          ...scrcpyServerArgs(scrcpyRelease.version, options.profile),
        ].join(" "),
      ],
      env: options.env,
      name: "device-scrcpy",
    });
    // Keep a bounded tail of the server's own words for a startup failure message.
    let said = "";
    const listen = (chunk: Buffer) => {
      said = (said + chunk.toString("utf8")).slice(-2048);
    };
    server.stdout.on("data", listen);
    server.stderr.on("data", listen);
    let exited = false;
    void server.exited.then(() => {
      exited = true;
    });
    const deadline = runtime.now() + (options.startupMs ?? 10_000);
    const remaining = () => Math.max(1, deadline - runtime.now());
    let video: Socket | undefined;
    let early: Buffer = Buffer.alloc(0);
    while (!video) {
      check();
      if (exited || runtime.now() > deadline)
        throw new DeviceError(
          "command_failed",
          `scrcpy-server did not start${said.trim() ? `: ${said.trim().split("\n").at(-1)}` : ""}`,
          "Use an emulator image with Android 5 or later, or stop other screen mirroring tools.",
        );
      const socket = await open(port).catch(() => undefined);
      if (socket) {
        sockets.push(socket);
        // The server answers its first socket with one dummy byte once it is listening.
        const greeting = await preamble(socket, 1, runtime, remaining());
        if (greeting) {
          video = socket;
          early = greeting.subarray(1);
        } else socket.destroy();
      }
      if (!video) await new Promise<void>((resolve) => runtime.after(100, resolve));
    }
    const control = await open(port);
    sockets.push(control);
    check();
    // The device name follows on the first socket once every socket is connected.
    const rest = await preamble(video, deviceNameBytes - early.length, runtime, remaining());
    if (!rest)
      throw new DeviceError(
        "command_failed",
        "scrcpy-server closed during startup",
        "Start the device view again.",
      );
    const meta = Buffer.concat([early, rest]);
    const nameBytes = meta.subarray(0, deviceNameBytes);
    const end = nameBytes.indexOf(0);
    return {
      video,
      control,
      initialVideo: meta.subarray(deviceNameBytes),
      deviceName: nameBytes.subarray(0, end < 0 ? nameBytes.length : end).toString("utf8"),
      exited: server.exited,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
