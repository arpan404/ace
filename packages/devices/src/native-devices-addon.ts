// SPDX-License-Identifier: Apache-2.0

/**
 * The devices addon (D3.1): loading it, and the one shape every export answers. It imports
 * nothing from the package, so both the platform shell and the SDK helpers can reach it without
 * a cycle: a caller turns a refusal into the `DeviceError` it names.
 */
import { fileURLToPath } from "node:url";

/** One SDK command the addon decided: `simctl` through `xcrun`, or the device's adb. */
export interface Step {
  kind: "simctl" | "adb";
  args: string[];
  maxBytes?: number;
  timeoutMs?: number;
}

/** `openApp`'s answer: the launch steps, or the lookup whose output decides them. */
export interface OpenAppPlan {
  steps: Step[];
  resolve?: Step;
}

/** What the listed Simulator turns the device into. */
export interface Selected {
  name: string;
  state: "booted";
  runtime: string;
}

export interface SimulatorEntry {
  udid: string;
  name: string;
  state: string;
  runtime: string;
}

export interface DiscoveryFile {
  name: string;
  text: string;
}

/** One device as a source read it, in `AppDevice`'s shape. */
export interface DeviceRecord {
  id: string;
  platform: string;
  name: string;
  state: string;
  runtime?: string | undefined;
  serial?: string | undefined;
  model?: string | undefined;
}

/** The folders a look read searches: the AVD roots and Xcode's DeviceKit roots. */
export interface ChromeRoots {
  avdRoots: string[];
  chromeRoots: string[];
}

/** One read step: files still to read, or what the read found once it had them. */
export interface ReadStep {
  read: string[];
  directory?: string;
  text?: string;
}

/** An image a skin draws, and the corner its diagonal scan starts at. */
export interface SkinImageRead {
  key: string;
  file: string;
  corner: [number, number] | null;
  reach: number;
}

/** A skin's opening, as the shell reads it back to build the look. */
export interface SkinPlan {
  width: number;
  height: number;
  x: number;
  y: number;
  background: string;
  mask?: string;
  short: number;
  reach: number;
  backCorner: [number, number] | null;
}

export interface SkinRead {
  plan: SkinPlan;
  images: SkinImageRead[];
}

/** One drawing of a body built from pieces, as `pdf-svg` paints it. */
export interface SvgArt {
  width: number;
  height: number;
  svg: string;
}

export interface PlacedPiece {
  art: SvgArt;
  rect: { x: number; y: number; width: number; height: number };
}

/** A Simulator look, and the pieces still to paint when its body is sliced. */
export interface ChromeAnswer {
  chrome: unknown | null;
  paint?: { width: number; height: number; pieces: PlacedPiece[] };
}

/** A PDF a chrome names, answered by its key. */
export interface ArtPath {
  key: string;
  path: string;
}

/** One platform's read: its devices, or the failure that stopped it. */
export interface ListSource {
  platform: string;
  devices: DeviceRecord[];
  failure?: RefusalWord | undefined;
}

/** The inventory and the missing SDKs a list found. */
export interface ListAnswer {
  devices: DeviceRecord[];
  missing: (RefusalWord & { platform: string })[];
}

/** A Simulator boot: boot it unless booted, then the `open` arguments that show its window. */
export interface IosBoot {
  boot: boolean;
  show: string[];
}

/** What booting an emulator needs decided: a port, its command line and adb's waits. */
export interface AndroidBootFacts {
  avd: string;
  used_serials: string[];
  taken_ports: number[];
  running: number;
  pending: boolean;
  closed: boolean;
  emulator_found: boolean;
  platform: string;
  arch?: string | undefined;
  window: boolean;
  gpu?: string | undefined;
}

export interface AndroidBoot {
  port: number;
  serial: string;
  args: string[];
  steps: Step[];
}

/** What one tools download fetches. */
export interface ToolsPlan {
  serveSim: boolean;
  scrcpy: boolean;
  timeoutMs: number;
}

/** One tools install, as `tools-entry` took its request. */
export interface ToolsInstallRequest {
  directory: string;
  node: string;
  serveSim: boolean;
  scrcpy: boolean;
  artifacts?: { serveSim: NpmArtifact; ws: NpmArtifact };
  scrcpyRelease?: { version: string; bytes: number; sha256: string; url: string };
  /** `ACE_SCRCPY_SERVER`: a verified local copy, passed explicitly. */
  scrcpyServer?: string;
  /** The staging directory's id, as the shell's clock and ids name it. */
  id: string;
  timeoutMs?: number;
}

/** One npm package tarball the tool install downloads. */
export interface NpmArtifact {
  name: string;
  version: string;
  url: string;
  integrity: string;
}

/** What a native tools install left in place, or why not. */
export interface ToolsInstallReply {
  serveSim?: { command: string; args: string[] };
  scrcpy?: string;
  error?: { code: string; message: string; hint: string };
}

/** An emulator's gRPC endpoint, when it serves one ace may use. */
export interface GrpcEndpoint {
  port: number;
  token: string;
}

/** A refusal as the addon writes it: today's `DeviceError`, field for field. */
export interface RefusalWord {
  code: string;
  message: string;
  hint: string;
}

/** One SDK root ace may read: what its `platform-tools` and `emulator` folders hold. */
export interface FoundTools {
  adb?: string | undefined;
  emulator?: string | undefined;
}

/** The Android tools ace runs, by absolute path. */
export interface AndroidTools {
  adb?: string | undefined;
  emulator?: string | undefined;
}

interface Answer<T> {
  ok: boolean;
  value?: T;
  error?: RefusalWord;
}

/** The addon's exports, as `ace-daemon-node/src/devices` declares them. */
interface DevicesAddon {
  devicePlatformIdentity(id: string, capture: boolean, inventory: string): string;
  devicePlatformInstall(platform: string, path: string): string;
  devicePlatformOpenApp(platform: string, app: string, resolved?: string): string;
  devicePlatformOpenUrl(platform: string, url: string): string;
  devicePlatformConfigure(platform: string, settings: string, physical: boolean): string;
  devicePlatformLaunchPid(stdout: string): string | null;
  devicePlatformConsolePort(serial: string): number | null;
  devicePlatformRunningDirectory(
    platform: string,
    home: string,
    env: Record<string, string>,
  ): string | null;
  devicePlatformEmulatorGrpc(serial: string, files: DiscoveryFile[]): string;
  devicePlatformEmulatorGrpcFile(serial: string, name: string, text: string): string;
  devicePlatformSimulatorRecord(entry: string): string;
  devicePlatformXcodeHostRefusal(platform: string): string;
  devicePlatformXcodeToolsRefusal(): string;
  devicePlatformXcodeProbeFailure(): string;
  devicePlatformXcodeSelection(code: number | null, stdout: string): string;
  devicePlatformIosNeedsMac(): string;
  devicePlatformArmEmulatorNote(): string;
  devicePlatformAndroidSdkRoots(
    platform: string,
    home: string | undefined,
    env: Record<string, string>,
  ): string[];
  devicePlatformChooseAndroidTools(found: FoundTools[], pathAdb?: string): string;
  devicePlatformResolveAndroidSdk(
    adb: string | undefined,
    emulator: string | undefined,
    platform: string,
    arch?: string,
  ): string;
  devicePlatformList(sources: string): string;
  devicePlatformIosBoot(id: string, booted: boolean): string;
  devicePlatformAndroidBoot(facts: string): string;
  devicePlatformShutdown(platform: string): string;
  devicePlatformEmulatorBootArgs(facts: string): string;
  devicePlatformDownloadPlan(
    platform: string,
    directory: string | undefined,
    node: string | undefined,
  ): string;
  devicePlatformAndroidDimensions(output: string): string;
  devicePlatformCatalogWord(key: string): string;
  devicePlatformInstallTools(request: string): Promise<string>;
  devicePlatformCatalogHint(key: string): string | null;
  devicePlatformManagedServeSim(directory: string, node: string, artifacts?: string): string;
  devicePlatformServeSimVersion(code: number | null, output: string): string | null;
  devicePlatformServeSimSupported(version: string | null): boolean;
  devicePlatformReplacesHelper(commandLine: string, version: string): boolean;
  devicePlatformSimulatorList(output: string): string;
  devicePlatformScrcpyEncode(message: string): Buffer;
  devicePlatformScrcpyInputPlan(
    input: string,
    display: string,
    video: string,
    nextSequence: number,
  ): string;
  devicePlatformHeldPointersRelease(held: string[]): string;
  devicePlatformFingerStep(op: string, held: string): string;
  devicePlatformKeyRefusal(ios: boolean, name: string, key: string): string | null;
  devicePlatformDeviceTouch(ios: boolean, multiTouch: boolean, input: boolean): string;
  devicePlatformBoundedClipboard(text: string, cut: boolean): string;
  devicePlatformAndroidClipboardRefusal(): string;
  devicePlatformSimulatorScreens(report: string): string;
  devicePlatformTouchTarget(screens: string, picture?: string): number;
  devicePlatformPostureRead(report: string, requested?: string): string | null;
  devicePlatformPostureAngle(posture: string): number;
  devicePlatformScreenCount(report: string): number | null;
  devicePlatformHasHinge(status: string): boolean;
  devicePlatformPostureFromHinge(reply: string): string | null;
  devicePlatformAndroidTree(xml: string, options: string): string;
  devicePlatformAndroidFind(tree: string, options: string): string;
  devicePlatformAndroidTarget(tree: string, reference: string): string;
  devicePlatformAndroidAct(node: string, action: string): string;
  devicePlatformSimulatorTree(raw: string, screen: string, options: string): string;
  devicePlatformSimulatorLayout(raw: string, screen: string): string;
  devicePlatformSimulatorTarget(tree: string, reference: string): string;
  devicePlatformSimulatorActionInput(node: string, action: string, turn: number): string;
  devicePlatformTypingArgs(device: string): string[];
  devicePlatformInputShell(serial: string, command: string, sequence: number): string[];
  devicePlatformUiHelperArgs(serial: string): string[];
  devicePlatformUiHelperTree(reply: string): string;
  devicePlatformDigitizerStep(message: string, target: number): string;
  devicePlatformKeyAction(key: string, orientation: string): string;
  devicePlatformNormalizedPoint(x: number, y: number, width: number, height: number): string;
  devicePlatformScreenEdge(x: number, y: number): number;
  devicePlatformHelperReply(line: string): string;
  devicePlatformInputAnswer(line: string, marker: string): boolean | null;
  devicePlatformPasteboardPlan(verb: string, udid: string): string;
  devicePlatformScrcpyClipboardStep(state: string | null, event: string): string;
  devicePlatformHeldPointersStep(state: string | null, input?: string): string;
  devicePlatformScrcpyDeviceReaderNew(): number;
  devicePlatformScrcpyDeviceReaderPush(id: number, chunk: string): string;
  devicePlatformScrcpyDeviceReaderDrop(id: number): void;
  devicePlatformSimulatorAxLimits(): string;
  devicePlatformNativeCalls(): number;
  devicePlatformImageLimits(): string;
  devicePlatformImageError(what: string, reason?: string, message?: string): string;
  devicePlatformChromeKey(
    platform: string,
    avd: string,
    simulatorType: string | undefined,
    open: boolean,
  ): string | null;
  devicePlatformPngKey(key: string): string;
  devicePlatformChromeRoots(env: string, home: string): string;
  devicePlatformAvdConfig(avd: string, roots: string, files: string): string;
  devicePlatformSkinDirectories(config: string, sdkRoots: string): string;
  devicePlatformSkinLayout(directories: string, files: string): string;
  devicePlatformSkinOpening(layout: string): string;
  devicePlatformSkinImage(bytes: Buffer, file: string): string | null;
  devicePlatformSkinChrome(
    plan: string,
    backUrl: string,
    backScan: string,
    maskUrl?: string,
    maskScan?: string,
  ): string;
  devicePlatformDeviceTypeBundle(types: string, identifier: string): string | null;
  devicePlatformChromeBundles(identifier: string, roots: string): string;
  devicePlatformBundleMatches(text: string, identifier: string): boolean;
  devicePlatformSimulatorArtPaths(
    bundle: string,
    chromeDirectory: string,
    chromeJson: string,
    mask: string | null,
    sensorBar: string | null,
  ): string;
  devicePlatformSimulatorPanels(profile: string | null, capabilities: string | null): string;
  devicePlatformSimulatorChrome(
    panel: string,
    chromeJson: string,
    arts: string,
    bodyUrl: string | undefined,
  ): string;
  devicePlatformChromeToPng(chrome: string, rendered: string | null): string;
}

const library =
  process.platform === "win32"
    ? "ace_daemon_node.dll"
    : process.platform === "darwin"
      ? "libace_daemon_node.dylib"
      : "libace_daemon_node.so";

/** The addon: `ACE_DEVICE_PLATFORM_ADDON`, else the development build in `native/daemon`. */
function addonPath(): string {
  const explicit = process.env.ACE_DEVICE_PLATFORM_ADDON;
  if (explicit) return explicit;
  return fileURLToPath(
    new URL(`../../../native/daemon/target/release/${library}`, import.meta.url),
  );
}

let loaded: DevicesAddon | undefined;

/** The devices addon, failing rather than falling back when the switch is on. */
export function nativeDevices(): DevicesAddon {
  if (loaded) return loaded;
  const path = addonPath();
  const module = { exports: {} as Record<string, unknown> };
  try {
    process.dlopen(module, path);
  } catch (error) {
    throw new Error(
      `ACE_DEVICE_PLATFORM=native needs the devices addon at ${path}; build it with cargo build --release -p ace-daemon-node in native/daemon`,
      { cause: error },
    );
  }
  // Trusted: the addon this tree built, exporting what `ace-daemon-node/src/devices` declares.
  loaded = module.exports as unknown as DevicesAddon;
  return loaded;
}

/** One export's answer: its value, or the refusal the caller raises as a `DeviceError`. */
export function answered<T>(invoke: () => string): T {
  const answer = JSON.parse(invoke()) as Answer<T>;
  // A bare value here is a wiring bug, never a device fact: say which, not "refused without a
  // message". Every refusal the addon answers carries a catalog word.
  if (typeof answer?.ok !== "boolean")
    throw new Error("ace-devices: the addon answered without an answer envelope");
  if (!answer.ok || answer.error) throw new Refused(answer.error);
  return answer.value as T;
}

/** A refusal the addon answered outside an envelope; a caller re-raises it as `DeviceError`. */
export class Refused extends Error {
  readonly refusal: RefusalWord;
  constructor(refusal: RefusalWord | undefined) {
    super(refusal?.message ?? "The device platform refused without a message");
    this.name = "Refused";
    this.refusal = refusal ?? {
      code: "command_failed",
      message: "The device platform refused without a message",
      hint: "Restart ace.",
    };
  }
}

/** The environment as the addon takes it: only the variables this process set. */
export function envStrings(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const strings: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) strings[key] = value;
  return strings;
}
