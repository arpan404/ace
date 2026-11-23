import { connect, type Socket } from "node:net";
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
  /** Video socket, positioned at the codec id; absent for a control-only server. */
  video: Socket | undefined;
  control: Socket;
  /** Bytes the video socket delivered with the preamble, to be read before later chunks. */
  initialVideo: Buffer;
  /** Device messages a control-only server sent with its preamble. */
  initialControl: Buffer;
  deviceName: string;
  exited: Promise<unknown>;
  close(): Promise<void>;
};

/**
 * The device side of a capture: the server pushed, forwarded and spawned, without any
 * socket connected. Both sides close what they opened: the daemon its control socket, the
 * tunnel and the source, ace-media its video socket.
 */
export type ScrcpyTunnel = {
  port: number;
  /** The server's exit, which does not reject. */
  exited: Promise<unknown>;
  /** Whether the server has exited. */
  isExited(): boolean;
  /** A bounded tail of the server's own words, for a startup failure message. */
  said(): string;
  close(): Promise<void>;
};

/** Today's startup failure: the server never greeted in time, with its last words. */
export function scrcpyDidNotStart(said: string): DeviceError {
  const last = said.trim().split("\n").at(-1) ?? "";
  return new DeviceError(
    "command_failed",
    `scrcpy-server did not start${last ? `: ${last}` : ""}`,
    "Use an Android 5 or later device or emulator image, or stop other screen mirroring tools.",
  );
}

/** The server went away mid-handshake: today's text for a close during startup. */
export function scrcpyClosedDuringStartup(): DeviceError {
  return new DeviceError(
    "command_failed",
    "scrcpy-server closed during startup",
    "Start the device view again.",
  );
}

/**
 * Pushes, forwards and spawns the pinned scrcpy server on one emulator, without connecting
 * either tunnel socket. The daemon connects control once ace-media greets (D1), or both
 * sockets itself as today.
 */
export async function startScrcpyTunnel(options: {
  adb: string;
  serial: string;
  jar: string;
  profile: ServerProfile;
  command: AdbCommand;
  runtime: DeviceRuntime;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<ScrcpyTunnel> {
  const { command, runtime } = options;
  const check = () => options.signal?.throwIfAborted();
  // The server deletes its own jar (`cleanup=true`), and a stopping server may do so late, so
  // every run pushes a copy of its own.
  const remoteJar = `/data/local/tmp/ace-${scrcpySocketName(options.profile.scid)}.jar`;
  const pushed = await command(["push", options.jar, remoteJar], 64 * 1024, 60_000);
  if (pushed.code !== 0)
    throw new DeviceError(
      "command_failed",
      "Could not copy scrcpy-server to the device",
      "Check that the device has free space in /data/local/tmp.",
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
  const server = runtime.spawn({
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
  // `exited` reports the server's exit and does not reject.
  void server.exited
    .then(() => {
      exited = true;
    })
    .catch(() => {});
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      await Promise.allSettled([
        server?.stop({ graceMs: 1000 }),
        command(["forward", "--remove", `tcp:${port}`], 4096, 5000),
      ]);
    })());
  return {
    port,
    exited: server.exited,
    isExited: () => exited,
    said: () => said,
    close,
  };
}

/**
 * Connects one tunnel socket, bounded by `timeoutMs`: adb accepts a TCP connection even
 * while nothing listens on the device, then closes it. A refusal, reset, timeout or abort
 * is `undefined`, never a throw; the caller names it with today's text.
 */
export function openScrcpySocket(
  port: number,
  runtime: DeviceRuntime,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Socket | undefined> {
  return new Promise((resolve) => {
    let done = false;
    let socket: Socket | undefined;
    const finish = (value: Socket | undefined) => {
      if (done) return;
      done = true;
      cancel();
      signal?.removeEventListener("abort", aborted);
      resolve(value);
    };
    const cancel = runtime.after(Math.max(1, timeoutMs), () => {
      socket?.destroy();
      finish(undefined);
    });
    const aborted = () => {
      socket?.destroy();
      finish(undefined);
    };
    if (signal?.aborted) {
      cancel();
      resolve(undefined);
      return;
    }
    signal?.addEventListener("abort", aborted, { once: true });
    const connecting = connect({ host: "127.0.0.1", port, noDelay: true });
    socket = connecting;
    connecting.once("connect", () => {
      connecting.off("error", failed);
      // Startup waits on this socket across awaits before the capture listens to it: a reset
      // (emulator killed, device unplugged) shows as its close, never as an unheard error.
      connecting.on("error", () => {});
      finish(connecting);
    });
    const failed = () => {
      connecting.destroy();
      finish(undefined);
    };
    connecting.once("error", failed);
  });
}

const deviceNameBytes = 64;

/**
 * Reads `count` bytes from a forward-tunnel connection, then pauses it. adb accepts the TCP
 * connection even while nothing listens on the device, then closes that: that is `undefined`.
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
      // Startup waits on this socket across awaits before the capture listens to it: a reset
      // (emulator killed, device unplugged) shows as its close, never as an unheard error.
      socket.on("error", () => {});
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

/**
 * Starts the pinned scrcpy server on one emulator and connects its video and control sockets
 * through an `adb forward` tunnel: video on (or off, `profile.video`), audio off, control on.
 * The server greets its first socket: the video one, or the control one when video is off.
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
  const { runtime } = options;
  const check = () => options.signal?.throwIfAborted();
  const tunnel = await startScrcpyTunnel(options);
  const sockets: Socket[] = [];
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      for (const socket of sockets) socket.destroy();
      await tunnel.close();
    })());
  try {
    const deadline = runtime.now() + (options.startupMs ?? 10_000);
    const remaining = () => Math.max(1, deadline - runtime.now());
    let first: Socket | undefined;
    let early: Buffer = Buffer.alloc(0);
    while (!first) {
      check();
      if (tunnel.isExited() || runtime.now() > deadline) throw scrcpyDidNotStart(tunnel.said());
      const socket = await open(tunnel.port).catch(() => undefined);
      if (socket) {
        sockets.push(socket);
        // The server answers its first socket with one dummy byte once it is listening.
        const greeting = await preamble(socket, 1, runtime, remaining());
        if (greeting) {
          first = socket;
          early = greeting.subarray(1);
        } else socket.destroy();
      }
      if (!first) await new Promise<void>((resolve) => runtime.after(100, resolve));
    }
    const hasVideo = options.profile.video !== false;
    const control = hasVideo ? await open(tunnel.port) : first;
    if (hasVideo) sockets.push(control);
    check();
    // The device name follows on the first socket once every socket is connected.
    const rest = await preamble(
      first,
      Math.max(0, deviceNameBytes - early.length),
      runtime,
      remaining(),
    );
    if (!rest) throw scrcpyClosedDuringStartup();
    const meta = Buffer.concat([early, rest]);
    const nameBytes = meta.subarray(0, deviceNameBytes);
    const end = nameBytes.indexOf(0);
    return {
      video: hasVideo ? first : undefined,
      control,
      initialVideo: hasVideo ? meta.subarray(deviceNameBytes) : Buffer.alloc(0),
      initialControl: hasVideo ? Buffer.alloc(0) : meta.subarray(deviceNameBytes),
      deviceName: nameBytes.subarray(0, end < 0 ? nameBytes.length : end).toString("utf8"),
      exited: tunnel.exited,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
