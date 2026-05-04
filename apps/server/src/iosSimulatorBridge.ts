import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import type { BrowserBridgeOperation } from "@ace/contracts";

const IOS_SIMULATOR_BRIDGE_OPERATIONS_LIST = [
  "ios_simulator_list_devices",
  "ios_simulator_boot",
  "ios_simulator_shutdown",
  "ios_simulator_open_url",
  "ios_simulator_launch_app",
  "ios_simulator_terminate_app",
  "ios_simulator_screenshot",
] as const;

export type IosSimulatorBridgeOperation = (typeof IOS_SIMULATOR_BRIDGE_OPERATIONS_LIST)[number];

export const IOS_SIMULATOR_BRIDGE_OPERATIONS = new Set<IosSimulatorBridgeOperation>(
  IOS_SIMULATOR_BRIDGE_OPERATIONS_LIST,
);

export function isIosSimulatorBridgeOperation(
  operation: BrowserBridgeOperation,
): operation is IosSimulatorBridgeOperation {
  return IOS_SIMULATOR_BRIDGE_OPERATIONS.has(operation as IosSimulatorBridgeOperation);
}

interface SimctlListDevicesResult {
  devices?: Record<string, unknown>;
}

interface SimctlDevice {
  readonly name: string;
  readonly udid: string;
  readonly runtime: string;
  readonly state: string;
  readonly isAvailable?: boolean;
}

interface IosSimulatorBridgeResult {
  readonly [key: string]: unknown;
}

interface ScreenshotTarget {
  readonly path: string;
  readonly removeAfter: boolean;
}

const SIMCTL_COMMAND = "xcrun";
const SIMCTL_TIMEOUT_MS = 30_000;
const SIMCTL_MAX_BUFFER_BYTES = 12 * 1024 * 1024;
const SCREENSHOT_TMP_PREFIX = "ace-simctl-screenshot-";

export async function runIosSimulatorBridgeRequest(input: {
  readonly operation: IosSimulatorBridgeOperation;
  readonly args: Readonly<Record<string, unknown>>;
}): Promise<IosSimulatorBridgeResult> {
  if (process.platform !== "darwin") {
    throw new Error("iOS simulator operations are available only on macOS.");
  }

  const args = input.args;
  switch (input.operation) {
    case "ios_simulator_list_devices": {
      const includeUnavailable =
        readBooleanArgAny(args, ["includeUnavailable", "include_unavailable", "all"]) === true;
      const stateFilter = normalizeNonEmptyString(
        readStringArgAny(args, ["state", "simulatorState"]),
      );
      const runtimeFilter = normalizeNonEmptyString(
        readStringArgAny(args, ["runtime", "runtimeFilter"]),
      );
      const nameFilter = normalizeNonEmptyString(
        readStringArgAny(args, ["name", "deviceName", "device_name"]),
      );
      const devices = parseSimctlDevices(runSimctlCommand(["list", "devices", "--json"]));
      const filtered = devices.filter((device) => {
        if (!includeUnavailable && device.isAvailable === false) {
          return false;
        }
        if (stateFilter && device.state.toLowerCase() !== stateFilter) {
          return false;
        }
        if (runtimeFilter && !device.runtime.toLowerCase().includes(runtimeFilter)) {
          return false;
        }
        if (nameFilter && !device.name.toLowerCase().includes(nameFilter)) {
          return false;
        }
        return true;
      });

      return {
        devices: filtered,
        total: filtered.length,
      };
    }
    case "ios_simulator_boot": {
      const deviceId = resolveDeviceId(args);
      runSimctlCommand(["boot", deviceId]);
      return { deviceId, operation: "ios_simulator_boot" };
    }
    case "ios_simulator_shutdown": {
      const deviceId = resolveDeviceId(args);
      runSimctlCommand(["shutdown", deviceId]);
      return { deviceId, operation: "ios_simulator_shutdown" };
    }
    case "ios_simulator_open_url": {
      const deviceId = resolveDeviceId(args);
      const url = readRequiredStringArg(args, ["url", "link", "address"]);
      runSimctlCommand(["openurl", deviceId, url]);
      return {
        deviceId,
        operation: "ios_simulator_open_url",
        url,
      };
    }
    case "ios_simulator_launch_app": {
      const deviceId = resolveDeviceId(args);
      const bundleId = readRequiredStringArg(args, [
        "bundleId",
        "bundleIdentifier",
        "bundle_id",
        "applicationId",
      ]);
      const launchArgs = readStringArrayArg(args, [
        "args",
        "arguments",
        "launchArgs",
        "launch_args",
      ]);
      const terminateRunning = readBooleanArgAny(args, [
        "terminateRunningProcess",
        "terminate_running_process",
        "terminateExistingProcesses",
        "terminate_existing_processes",
      ]);
      runSimctlCommand([
        "launch",
        ...(terminateRunning === true ? ["--terminate-running-processes"] : []),
        deviceId,
        bundleId,
        ...launchArgs,
      ]);
      return {
        bundleId,
        deviceId,
        operation: "ios_simulator_launch_app",
      };
    }
    case "ios_simulator_terminate_app": {
      const deviceId = resolveDeviceId(args);
      const bundleId = readRequiredStringArg(args, [
        "bundleId",
        "bundleIdentifier",
        "bundle_id",
        "applicationId",
      ]);
      runSimctlCommand(["terminate", deviceId, bundleId]);
      return {
        bundleId,
        deviceId,
        operation: "ios_simulator_terminate_app",
      };
    }
    case "ios_simulator_screenshot": {
      const deviceId = resolveDeviceId(args);
      const imageFormat = normalizeImageFormat(
        readStringArgAny(args, ["format", "imageFormat", "image_format", "type"]) ?? "png",
      );
      const screenshotTarget = resolveScreenshotTarget(args, imageFormat);
      let imageBuffer: Buffer | undefined;
      try {
        imageBuffer = captureSimulatorScreenshot(deviceId, screenshotTarget.path, imageFormat);
      } finally {
        if (screenshotTarget.removeAfter) {
          rmSync(dirname(screenshotTarget.path), { force: true, recursive: true });
        }
      }

      if (imageBuffer === undefined) {
        throw new Error("Failed to capture iOS simulator screenshot.");
      }

      return {
        imageDataUrl: `data:${imageMimeFromFormat(imageFormat)};base64,${imageBuffer.toString("base64")}`,
        mimeType: imageMimeFromFormat(imageFormat),
        operation: "ios_simulator_screenshot",
        path: screenshotTarget.path,
      };
    }
    default:
      throw new Error(`Unsupported iOS simulator operation: ${input.operation}`);
  }
}

function normalizeNonEmptyString(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function readStringArgAny(
  args: Readonly<Record<string, unknown>>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = readStringArg(args, key);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function readStringArg(args: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readRequiredStringArg(args: Readonly<Record<string, unknown>>, keys: string[]): string {
  const value = readStringArgAny(args, keys);
  if (value === undefined) {
    throw new Error(`Missing required string argument. Expected one of: ${keys.join(", ")}.`);
  }
  return value;
}

function readBooleanArgAny(
  args: Readonly<Record<string, unknown>>,
  keys: string[],
): boolean | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function readStringArrayArg(args: Readonly<Record<string, unknown>>, keys: string[]): string[] {
  for (const key of keys) {
    const value = args[key];
    if (!Array.isArray(value)) {
      continue;
    }
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0);
  }
  return [];
}

function parseSimctlDevices(rawJson: string): SimctlDevice[] {
  let payload: SimctlListDevicesResult;
  try {
    payload = JSON.parse(rawJson) as SimctlListDevicesResult;
  } catch {
    throw new Error("xcrun simctl returned invalid JSON for device list.");
  }

  const devicesByRuntime = payload.devices;
  if (
    !devicesByRuntime ||
    typeof devicesByRuntime !== "object" ||
    Array.isArray(devicesByRuntime)
  ) {
    return [];
  }

  const parsed: SimctlDevice[] = [];
  for (const [runtime, rawDevices] of Object.entries(devicesByRuntime)) {
    if (!Array.isArray(rawDevices)) {
      continue;
    }
    for (const rawDevice of rawDevices) {
      if (!rawDevice || typeof rawDevice !== "object") {
        continue;
      }
      const deviceRecord = rawDevice as Record<string, unknown>;
      const name = readStringArg(deviceRecord, "name");
      const udid = readStringArg(deviceRecord, "udid");
      const state = readStringArg(deviceRecord, "state");
      const isAvailable = readBooleanArg(deviceRecord, "isAvailable");
      if (!name || !udid || !state) {
        continue;
      }
      parsed.push({
        name,
        udid,
        runtime,
        state,
        isAvailable,
      });
    }
  }

  return parsed;
}

function readBooleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (normalized === "yes" || normalized === "true") return true;
    if (normalized === "no" || normalized === "false") return false;
  }
  return undefined;
}

function resolveDeviceId(args: Readonly<Record<string, unknown>>): string {
  const explicitDeviceId = readStringArgAny(args, [
    "udid",
    "deviceId",
    "device_id",
    "simulatorId",
    "simulator_id",
  ]);
  if (explicitDeviceId) {
    return explicitDeviceId;
  }

  const deviceName = readRequiredStringArg(args, ["name", "deviceName", "device_name"]);
  const normalizedName = deviceName.trim().toLowerCase();
  const devices = parseSimctlDevices(runSimctlCommand(["list", "devices", "--json"]));
  const exactMatch = devices.find((device) => device.name.toLowerCase() === normalizedName);
  if (!exactMatch) {
    const partialMatch = devices.filter((device) =>
      device.name.toLowerCase().includes(normalizedName),
    );
    if (partialMatch.length === 0) {
      throw new Error(`No simulator matched name "${deviceName}".`);
    }
    if (partialMatch.length > 1) {
      const names = partialMatch.map((device) => device.name).join(", ");
      throw new Error(
        `Multiple simulators match "${deviceName}" (${names}). Specify a deviceId/udid instead.`,
      );
    }
    return partialMatch[0]!.udid;
  }

  return exactMatch.udid;
}

function resolveScreenshotTarget(
  args: Readonly<Record<string, unknown>>,
  imageFormat: "jpg" | "png" | "tiff",
): ScreenshotTarget {
  const explicitPath = readStringArgAny(args, ["path", "outputPath", "output_path", "file"]);
  if (explicitPath) {
    return { path: explicitPath, removeAfter: false };
  }

  const tempDir = mkdtempSync(join(tmpdir(), SCREENSHOT_TMP_PREFIX));
  const extension = imageFormat === "jpg" ? "jpg" : imageFormat;
  return {
    path: join(tempDir, `${Date.now()}-${randomUUID()}.${extension}`),
    removeAfter: true,
  };
}

function captureSimulatorScreenshot(
  deviceId: string,
  screenshotPath: string,
  imageFormat: "jpg" | "png" | "tiff",
): Buffer {
  runSimctlCommand(["io", deviceId, "screenshot", "--type", imageFormat, screenshotPath]);
  return readFileSync(screenshotPath);
}

function normalizeImageFormat(format: string): "jpg" | "png" | "tiff" {
  const normalized = format.trim().toLowerCase();
  if (
    normalized === "jpg" ||
    normalized === "jpeg" ||
    normalized === "png" ||
    normalized === "tiff"
  ) {
    return normalized === "jpeg" ? "jpg" : normalized;
  }
  return "png";
}

function imageMimeFromFormat(format: "jpg" | "png" | "tiff"): string {
  if (format === "jpg") return "image/jpeg";
  if (format === "png") return "image/png";
  return "image/tiff";
}

function runSimctlCommand(args: string[]): string {
  const result = spawnSync(SIMCTL_COMMAND, ["simctl", ...args], {
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: SIMCTL_TIMEOUT_MS,
    maxBuffer: SIMCTL_MAX_BUFFER_BYTES,
  });

  if (result.error) {
    const message = result.error.message.toLowerCase();
    if (message.includes("enoent") || message.includes("command not found")) {
      throw new Error(
        "xcrun is unavailable. Install Xcode Command Line Tools and ensure xcrun is on PATH.",
      );
    }
    throw new Error(`Failed to execute xcrun simctl: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const stderr = String(result.stderr ?? "").trim();
    const stdout = String(result.stdout ?? "").trim();
    const detail = stderr || stdout || `Exited with status ${String(result.status)}`;
    throw new Error(`xcrun simctl failed: ${detail}`);
  }

  return String(result.stdout ?? "");
}
