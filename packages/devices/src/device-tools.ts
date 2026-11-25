import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { devicePlatformBackend } from "@ace/provider-kit/native-switches";
import { DeviceFailure } from "@ace/protocol/devices";
import { ToolsReply, type ToolsRequest } from "./device-tools-wire.ts";
import type { DeviceRuntime } from "./runtime.ts";
import { catalogHint } from "./catalog.ts";
import { DeviceError, deviceAnswer } from "./sdk.ts";
import {
  nativeDevices,
  type ToolsInstallRequest,
  type ToolsInstallReply,
} from "./native-devices-addon.ts";
import type { ServeSimCommand } from "./serve-sim-install.ts";

/** A download that hasn't finished in this long is stopped (slow links get a long allowance). */
const installTimeoutMs = 5 * 60_000;
const replyLimit = 64 * 1024;

export interface DeviceToolsOptions {
  /** ace's tools directory, inside its home. */
  directory: string;
  /** The daemon's Node: it runs the tools process and serve-sim's script. */
  node: string;
  runtime: Pick<DeviceRuntime, "spawn" | "after">;
  env: NodeJS.ProcessEnv;
  /** Other pinned serve-sim packages; tests serve their own. */
  artifacts?: ToolsRequest["artifacts"];
  /** The download's budget; the platform decides it (`toolsPlan`). */
  timeoutMs?: number;
}

/** What a tools download left in place. */
export interface DeviceTools {
  serveSim?: ServeSimCommand;
  scrcpy?: string;
}

const entry = () => fileURLToPath(new URL("./tools-entry.ts", import.meta.url));

/**
 * Makes sure the device tools ace runs are downloaded: serve-sim on a Mac, the scrcpy server
 * everywhere. The download, its checksums and the unpacking run in a process of their own, so
 * none of it touches the daemon's event loop; the daemon only reads its one-line reply.
 */
export async function downloadDeviceTools(
  options: DeviceToolsOptions,
  wants: Pick<ToolsRequest, "serveSim" | "scrcpy">,
): Promise<DeviceTools> {
  if (devicePlatformBackend() === "native") return downloadNatively(options, wants);
  const request: ToolsRequest = {
    directory: options.directory,
    node: options.node,
    ...wants,
    ...(options.artifacts ? { artifacts: options.artifacts } : {}),
  };
  const child = options.runtime.spawn({
    command: options.node,
    args: [entry(), JSON.stringify(request)],
    env: options.env,
    name: "device-tools",
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    if (output.length < replyLimit) output += chunk.toString("utf8");
  });
  child.stderr.resume();
  let timedOut = false;
  const cancel = options.runtime.after(options.timeoutMs ?? installTimeoutMs, () => {
    timedOut = true;
    void child.stop({ graceMs: 0 }).catch(() => {});
  });
  try {
    await child.exited;
  } finally {
    cancel();
    await child.stop({ graceMs: 0 }).catch(() => {});
  }
  if (timedOut)
    throw new DeviceError("timeout", catalogHint("downloadTimeout"), catalogHint("downloadHint"));
  const parsed = ToolsReply.safeParse(
    (() => {
      try {
        return JSON.parse(output.trim().split("\n").at(-1) ?? "null");
      } catch {
        return undefined;
      }
    })(),
  );
  if (!parsed.success)
    throw new DeviceError(
      "command_failed",
      "The device tools download stopped without an answer",
      catalogHint("againHint"),
    );
  const reply = parsed.data;
  if (reply.error) {
    const code = DeviceFailure.shape.code.safeParse(reply.error.code);
    throw new DeviceError(
      code.success ? code.data : "tool_missing",
      reply.error.message,
      reply.error.hint,
    );
  }
  return {
    ...(reply.serveSim ? { serveSim: reply.serveSim } : {}),
    ...(reply.scrcpy ? { scrcpy: reply.scrcpy } : {}),
  };
}

/**
 * The same download on the native runtime (D3.1): `ace-devices` fetches, checks and unpacks off
 * the JavaScript thread, with the budget the platform's plan set.
 */
async function downloadNatively(
  options: DeviceToolsOptions,
  wants: Pick<ToolsRequest, "serveSim" | "scrcpy">,
): Promise<DeviceTools> {
  const request: ToolsInstallRequest = {
    directory: options.directory,
    node: options.node,
    ...wants,
    ...(options.artifacts ? { artifacts: options.artifacts } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    id: randomUUID(),
    // An empty setting is unset, as the child's `if (explicit)` read it.
    ...(options.env["ACE_SCRCPY_SERVER"] ? { scrcpyServer: options.env["ACE_SCRCPY_SERVER"] } : {}),
  };
  const text = await nativeDevices().devicePlatformInstallTools(JSON.stringify(request));
  const reply = deviceAnswer<ToolsInstallReply>(() => text);
  return {
    ...(reply.serveSim ? { serveSim: reply.serveSim } : {}),
    ...(reply.scrcpy ? { scrcpy: reply.scrcpy } : {}),
  };
}
