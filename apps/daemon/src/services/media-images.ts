import { ImageProcess } from "@ace/media/image-process";
import { unavailableImages, type ImageWork } from "@ace/media/images";
import { nodeByteSink, nodeByteSource } from "@ace/media/lanes";
import { systemMediaClock, type MediaChild, type MediaClock } from "@ace/media/supervisor";
import { spawnRawSupervisedExactEnv } from "@ace/provider-kit/process";
import type { MediaLog } from "@ace/media/supervisor";
import { residentSampler, residentSamplingAvailable } from "@ace/provider-kit/resident-memory";
import { findMediaBinary } from "./media.ts";
import type { ServiceContext } from "./types.ts";

/*
 * The daemon's image work (ADR 0208): ace-media's image process, on every OS, apart from the
 * media process and whatever that does on this platform. It starts on the first image job and
 * stops when idle.
 */

/** Past this much memory (resident or swapped) the image process is killed and restarted. */
export const imageMemoryLimitBytes = 1536 * 1024 * 1024;

export type DaemonImagesOptions = {
  /** The ace-media binary, or undefined when this install has none. */
  binary: string | undefined;
  /** The data directory: the only place file inputs come from. */
  root: string;
  platform: NodeJS.Platform;
  spawn: (binary: string, args: readonly string[]) => MediaChild;
  clock: MediaClock;
  id: () => string;
  random: () => number;
  log: MediaLog;
};

/** An image process for this daemon, or work that says why there can't be one. */
export function createDaemonImages(options: DaemonImagesOptions): ImageWork & { dispose(): void } {
  const { binary, platform } = options;
  if (!binary) return { ...unavailableImages("no ace-media binary was found"), dispose() {} };
  const images = new ImageProcess({
    binary,
    root: options.root,
    spawn: options.spawn,
    clock: options.clock,
    nextId: options.id,
    random: options.random,
    log: options.log,
    ...(residentSamplingAvailable(platform)
      ? {
          memory: {
            sample: residentSampler(platform),
            limitBytes: imageMemoryLimitBytes,
            intervalMs: 1_000,
          },
        }
      : {}),
  });
  return { run: (job) => images.run(job), dispose: () => images.dispose() };
}

/**
 * The image worker's whole environment: none of the daemon's (its credentials, tokens and
 * settings stay out), only what the OS needs to start a process on this platform.
 */
export function imageWorkerEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  if (platform !== "win32") return {};
  const kept = ["SystemRoot", "SystemDrive", "windir", "TEMP", "TMP"];
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) =>
        value !== undefined && kept.some((name) => name.toLowerCase() === key.toLowerCase()),
    ),
  );
}

/** The image worker as an owned child with exactly `env`. */
function spawnImageWorker(env: NodeJS.ProcessEnv) {
  return (binary: string, args: readonly string[]): MediaChild => {
    const child = spawnRawSupervisedExactEnv({
      command: binary,
      args: [...args],
      env,
      name: "ace-media-images",
    });
    return {
      pid: child.pid,
      stdin: nodeByteSink(child.stdin),
      stdout: nodeByteSource(child.stdout),
      stderr: nodeByteSource(child.stderr),
      exited: child.exited.then(({ code, signal }) => ({ code, signal })),
      kill: () => void child.stop({ graceMs: 0 }),
    };
  };
}

const started = new WeakMap<object, ImageWork>();

/** The daemon's image work, made once per daemon. */
export function daemonImages(context: ServiceContext): ImageWork {
  const known = started.get(context.services);
  if (known) return known;
  const images = createDaemonImages({
    binary: findMediaBinary(),
    root: context.config.dataDir,
    platform: process.platform,
    spawn: spawnImageWorker(imageWorkerEnv(process.env, process.platform)),
    clock: systemMediaClock,
    id: context.id,
    // Backoff jitter only.
    random: Math.random,
    log: (level, message, fields) => context.log.log(level, `ace-media images: ${message}`, fields),
  });
  context.resources.own(() => images.dispose());
  started.set(context.services, images);
  return images;
}
