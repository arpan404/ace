import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { dialog, session, shell } from "electron";
import type { BrowserWindow, WebContents, WebFrameMain } from "electron";
import type {
  DesktopBrowserDownload,
  DesktopBrowserDownloadAction,
  DesktopBrowserDownloadEvent,
  DesktopBrowserPermission,
  DesktopBrowserPermissionSetting,
  DesktopBrowserSiteInfo,
  DesktopBrowserSitePermission,
} from "@ace/contracts";

interface ConfigureInAppBrowserSessionFeaturesOptions {
  readonly extensionDirectories?: readonly string[];
  readonly getOwnerWindow: () => BrowserWindow | null;
  readonly log: (message: string) => void;
  readonly partition: string;
  readonly permissionStorePath?: string;
  readonly sendDownloadEvent?: (event: DesktopBrowserDownloadEvent) => void;
  readonly userAgent?: string;
}

interface BrowserWebAuthnAccount {
  readonly credentialId?: string;
  readonly displayName?: string;
  readonly name?: string;
  readonly userHandle?: string;
}

interface BrowserDeviceChoice {
  readonly description: string;
  readonly id: string;
  readonly label: string;
}

const configuredBrowserSessions = new WeakSet<Electron.Session>();
const BROWSER_EXTENSION_LOAD_TIMEOUT_MS = 5_000;
const MAX_DEVICE_DIALOG_CHOICES = 8;
const MAX_RETAINED_DOWNLOAD_SNAPSHOTS = 50;
const trackedDownloads = new Map<
  string,
  { readonly item: Electron.DownloadItem; snapshot: DesktopBrowserDownload }
>();
const retainedDownloadSnapshots = new Map<string, DesktopBrowserDownload>();
const permissionStoreByPath = new Map<string, BrowserPermissionStore>();
const inMemoryPermissionStore = new Map<string, BrowserPermissionRecord>();
let activeBrowserSessionOptions: ConfigureInAppBrowserSessionFeaturesOptions | null = null;

type BrowserPermissionRecord = Partial<
  Record<DesktopBrowserPermission, { setting: DesktopBrowserPermissionSetting; updatedAt: string }>
>;

const BROWSER_PERMISSION_ORDER: readonly DesktopBrowserPermission[] = [
  "camera",
  "microphone",
  "media",
  "clipboard",
  "displayCapture",
  "fileSystem",
  "fullscreen",
  "geolocation",
  "hid",
  "idleDetection",
  "keyboardLock",
  "midi",
  "notifications",
  "openExternal",
  "pointerLock",
  "serial",
  "speakerSelection",
  "storageAccess",
  "topLevelStorageAccess",
  "usb",
  "windowManagement",
];

const PERMISSION_LABELS: Record<DesktopBrowserPermission, string> = {
  camera: "camera",
  microphone: "microphone",
  media: "camera and microphone",
  clipboard: "clipboard",
  displayCapture: "screen sharing",
  fileSystem: "files",
  fullscreen: "fullscreen",
  geolocation: "location",
  hid: "HID devices",
  idleDetection: "idle detection",
  keyboardLock: "keyboard lock",
  midi: "MIDI devices",
  notifications: "notifications",
  openExternal: "external app links",
  pointerLock: "pointer lock",
  serial: "serial ports",
  speakerSelection: "speaker selection",
  storageAccess: "third-party storage",
  topLevelStorageAccess: "top-level storage",
  usb: "USB devices",
  windowManagement: "window management",
};

function sanitizeLogValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function parseUrlOrigin(rawUrl: string): string | null {
  try {
    const parsedUrl = new URL(rawUrl);
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      return null;
    }
    return parsedUrl.origin;
  } catch {
    return null;
  }
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(FS.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  FS.mkdirSync(Path.dirname(filePath), { recursive: true });
  FS.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isBrowserPermission(value: unknown): value is DesktopBrowserPermission {
  return (
    typeof value === "string" &&
    BROWSER_PERMISSION_ORDER.includes(value as DesktopBrowserPermission)
  );
}

function isBrowserPermissionSetting(value: unknown): value is DesktopBrowserPermissionSetting {
  return value === "allow" || value === "ask" || value === "block";
}

function parsePermissionRecord(value: unknown): BrowserPermissionRecord {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const record: BrowserPermissionRecord = {};
  for (const [rawPermission, rawGrant] of Object.entries(value)) {
    if (!isBrowserPermission(rawPermission)) {
      continue;
    }
    if (typeof rawGrant !== "object" || rawGrant === null) {
      continue;
    }
    const grant = rawGrant as { readonly setting?: unknown; readonly updatedAt?: unknown };
    if (!isBrowserPermissionSetting(grant.setting) || grant.setting === "ask") {
      continue;
    }
    record[rawPermission] = {
      setting: grant.setting,
      updatedAt: typeof grant.updatedAt === "string" ? grant.updatedAt : new Date().toISOString(),
    };
  }
  return record;
}

function parsePermissionStore(value: unknown): Map<string, BrowserPermissionRecord> {
  const store = new Map<string, BrowserPermissionRecord>();
  if (typeof value !== "object" || value === null) {
    return store;
  }
  const rawOrigins =
    "origins" in value && typeof (value as { origins?: unknown }).origins === "object"
      ? (value as { origins?: unknown }).origins
      : value;
  if (typeof rawOrigins !== "object" || rawOrigins === null) {
    return store;
  }
  for (const [origin, rawRecord] of Object.entries(rawOrigins)) {
    const normalizedOrigin = parseUrlOrigin(origin);
    if (!normalizedOrigin) {
      continue;
    }
    const record = parsePermissionRecord(rawRecord);
    if (Object.keys(record).length > 0) {
      store.set(normalizedOrigin, record);
    }
  }
  return store;
}

class BrowserPermissionStore {
  readonly #filePath: string | null;
  #records: Map<string, BrowserPermissionRecord>;

  constructor(filePath: string | null) {
    this.#filePath = filePath;
    this.#records = filePath
      ? parsePermissionStore(readJsonFile(filePath))
      : inMemoryPermissionStore;
  }

  get(origin: string, permission: DesktopBrowserPermission): DesktopBrowserPermissionSetting {
    return this.#records.get(origin)?.[permission]?.setting ?? "ask";
  }

  list(origin: string): DesktopBrowserSitePermission[] {
    const record = this.#records.get(origin) ?? {};
    return BROWSER_PERMISSION_ORDER.map((permission) => ({
      permission,
      setting: record[permission]?.setting ?? "ask",
      updatedAt: record[permission]?.updatedAt ?? null,
    }));
  }

  reset(origin: string): boolean {
    const deleted = this.#records.delete(origin);
    if (deleted) {
      this.#persist();
    }
    return true;
  }

  set(
    origin: string,
    permission: DesktopBrowserPermission,
    setting: DesktopBrowserPermissionSetting,
  ): boolean {
    if (setting === "ask") {
      const record = this.#records.get(origin);
      if (record) {
        delete record[permission];
        if (Object.keys(record).length === 0) {
          this.#records.delete(origin);
        }
      }
      this.#persist();
      return true;
    }

    const record = this.#records.get(origin) ?? {};
    record[permission] = { setting, updatedAt: new Date().toISOString() };
    this.#records.set(origin, record);
    this.#persist();
    return true;
  }

  #persist(): void {
    if (!this.#filePath) {
      return;
    }
    const origins = Object.fromEntries(this.#records.entries());
    writeJsonFile(this.#filePath, { origins });
  }
}

function getPermissionStore(filePath: string | null | undefined): BrowserPermissionStore {
  if (!filePath) {
    return new BrowserPermissionStore(null);
  }
  const existing = permissionStoreByPath.get(filePath);
  if (existing) {
    return existing;
  }
  const created = new BrowserPermissionStore(filePath);
  permissionStoreByPath.set(filePath, created);
  return created;
}

function formatWebAuthnAccountLabel(account: BrowserWebAuthnAccount, index: number): string {
  const displayName = account.displayName?.trim();
  const name = account.name?.trim();
  if (displayName && name && displayName !== name) {
    return `${displayName} (${name})`;
  }
  return displayName || name || `Passkey ${String(index + 1)}`;
}

async function showBrowserFeatureDialog(
  ownerWindow: BrowserWindow | null,
  options: Electron.MessageBoxOptions,
): Promise<Electron.MessageBoxReturnValue> {
  return ownerWindow && !ownerWindow.isDestroyed()
    ? dialog.showMessageBox(ownerWindow, options)
    : dialog.showMessageBox(options);
}

async function chooseWebAuthnAccount(input: {
  readonly accounts: readonly BrowserWebAuthnAccount[];
  readonly getOwnerWindow: () => BrowserWindow | null;
  readonly relyingPartyId: string;
}): Promise<string | null> {
  const accounts = input.accounts.filter(
    (account): account is BrowserWebAuthnAccount & { readonly credentialId: string } =>
      typeof account.credentialId === "string" && account.credentialId.length > 0,
  );

  if (accounts.length === 0) {
    return null;
  }
  if (accounts.length === 1) {
    return accounts[0]?.credentialId ?? null;
  }

  const accountLabels = accounts.map(formatWebAuthnAccountLabel);
  const buttons = [...accountLabels, "Cancel"];
  const cancelId = buttons.length - 1;
  const result = await showBrowserFeatureDialog(input.getOwnerWindow(), {
    type: "question",
    title: "Choose passkey",
    message: `Choose a passkey for ${input.relyingPartyId}.`,
    buttons,
    defaultId: 0,
    cancelId,
    noLink: true,
  });

  if (result.response < 0 || result.response >= accounts.length) {
    return null;
  }
  return accounts[result.response]?.credentialId ?? null;
}

function formatHexDeviceId(value: number): string {
  return `0x${value.toString(16).padStart(4, "0")}`;
}

function joinDeviceDetails(details: readonly string[]): string {
  return details.filter((detail) => detail.trim().length > 0).join(", ");
}

function formatHidDeviceChoice(device: Electron.HIDDevice, index: number): BrowserDeviceChoice {
  const label = device.name.trim() || `HID device ${String(index + 1)}`;
  return {
    id: device.deviceId,
    label,
    description: joinDeviceDetails([
      `vendor ${formatHexDeviceId(device.vendorId)}`,
      `product ${formatHexDeviceId(device.productId)}`,
      device.serialNumber ? `serial ${device.serialNumber}` : "",
    ]),
  };
}

function formatUsbDeviceChoice(device: Electron.USBDevice, index: number): BrowserDeviceChoice {
  const productName = device.productName?.trim();
  const manufacturerName = device.manufacturerName?.trim();
  const label =
    productName && manufacturerName && !productName.includes(manufacturerName)
      ? `${manufacturerName} ${productName}`
      : productName || manufacturerName || `USB device ${String(index + 1)}`;
  return {
    id: device.deviceId,
    label,
    description: joinDeviceDetails([
      `vendor ${formatHexDeviceId(device.vendorId)}`,
      `product ${formatHexDeviceId(device.productId)}`,
      device.serialNumber ? `serial ${device.serialNumber}` : "",
    ]),
  };
}

function formatSerialPortChoice(port: Electron.SerialPort, index: number): BrowserDeviceChoice {
  const label =
    port.displayName?.trim() || port.portName.trim() || `Serial port ${String(index + 1)}`;
  return {
    id: port.portId,
    label,
    description: joinDeviceDetails([
      port.portName ? `port ${port.portName}` : "",
      port.vendorId ? `vendor ${port.vendorId}` : "",
      port.productId ? `product ${port.productId}` : "",
      port.serialNumber ? `serial ${port.serialNumber}` : "",
    ]),
  };
}

function formatBrowserDeviceChoice(choice: BrowserDeviceChoice, index: number): string {
  return `${String(index + 1)}. ${choice.label}`;
}

function formatDeviceDialogDetail(choices: readonly BrowserDeviceChoice[]): string {
  return choices
    .map((choice, index) => {
      const description = choice.description.trim();
      return description
        ? `${formatBrowserDeviceChoice(choice, index)} - ${description}`
        : formatBrowserDeviceChoice(choice, index);
    })
    .join("\n");
}

function resolveOriginLabel(origin: string): string {
  if (origin.length === 0 || origin === "null") {
    return "this site";
  }

  try {
    const parsedUrl = new URL(origin);
    if (parsedUrl.host.length > 0) {
      return parsedUrl.host;
    }
  } catch {
    // Fall through to the sanitized origin string below.
  }

  return origin;
}

function resolveFrameOriginLabel(frame: WebFrameMain | null | undefined): string {
  if (!frame || frame.isDestroyed()) {
    return "this site";
  }

  return resolveOriginLabel(frame.origin || frame.url);
}

async function chooseBrowserDevice(input: {
  readonly choices: readonly BrowserDeviceChoice[];
  readonly deviceKindLabel: string;
  readonly getOwnerWindow: () => BrowserWindow | null;
  readonly originLabel: string;
}): Promise<string | null> {
  const choices = input.choices.slice(0, MAX_DEVICE_DIALOG_CHOICES);
  if (choices.length === 0) {
    await showBrowserFeatureDialog(input.getOwnerWindow(), {
      type: "info",
      title: `No ${input.deviceKindLabel} found`,
      message: `${input.originLabel} requested a ${input.deviceKindLabel}, but no compatible devices are available.`,
      buttons: ["OK"],
      defaultId: 0,
      noLink: true,
    });
    return null;
  }

  if (choices.length === 1) {
    const [choice] = choices;
    if (!choice) {
      return null;
    }
    const result = await showBrowserFeatureDialog(input.getOwnerWindow(), {
      type: "question",
      title: `Allow ${input.deviceKindLabel} access`,
      message: `${input.originLabel} wants to use ${choice.label}.`,
      ...(choice.description ? { detail: choice.description } : {}),
      buttons: ["Allow", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    return result.response === 0 ? choice.id : null;
  }

  const buttons = [...choices.map(formatBrowserDeviceChoice), "Cancel"];
  const cancelId = buttons.length - 1;
  const extraDeviceCount = input.choices.length - choices.length;
  const result = await showBrowserFeatureDialog(input.getOwnerWindow(), {
    type: "question",
    title: `Choose ${input.deviceKindLabel}`,
    message: `${input.originLabel} wants to use a ${input.deviceKindLabel}.`,
    detail:
      formatDeviceDialogDetail(choices) +
      (extraDeviceCount > 0 ? `\n${String(extraDeviceCount)} more devices hidden.` : ""),
    buttons,
    defaultId: 0,
    cancelId,
    noLink: true,
  });

  if (result.response < 0 || result.response >= choices.length) {
    return null;
  }
  return choices[result.response]?.id ?? null;
}

function getWebContentsOriginLabel(webContents: WebContents): string {
  return resolveOriginLabel(webContents.getURL());
}

function resolvePermissionOrigin(input: {
  readonly details?: Electron.PermissionCheckHandlerHandlerDetails | Electron.PermissionRequest;
  readonly requestingOrigin?: string;
  readonly webContents?: WebContents | null;
}): string | null {
  const candidates = [
    input.requestingOrigin,
    input.details && "securityOrigin" in input.details ? input.details.securityOrigin : undefined,
    input.details?.requestingUrl,
    input.webContents?.getURL(),
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const origin = parseUrlOrigin(candidate);
    if (origin) {
      return origin;
    }
  }
  return null;
}

function resolveBrowserPermission(
  permission: string,
  details?:
    | Electron.PermissionCheckHandlerHandlerDetails
    | Electron.PermissionRequest
    | Electron.MediaAccessPermissionRequest,
): DesktopBrowserPermission | null {
  switch (permission) {
    case "clipboard-read":
    case "clipboard-sanitized-write":
    case "deprecated-sync-clipboard-read":
      return "clipboard";
    case "display-capture":
      return "displayCapture";
    case "fileSystem":
      return "fileSystem";
    case "fullscreen":
      return "fullscreen";
    case "geolocation":
      return "geolocation";
    case "hid":
      return "hid";
    case "idle-detection":
      return "idleDetection";
    case "keyboardLock":
      return "keyboardLock";
    case "media": {
      const mediaTypes =
        details && "mediaTypes" in details && Array.isArray(details.mediaTypes)
          ? details.mediaTypes
          : [];
      if (mediaTypes.includes("audio") && mediaTypes.includes("video")) {
        return "media";
      }
      if (mediaTypes.includes("audio")) {
        return "microphone";
      }
      if (mediaTypes.includes("video")) {
        return "camera";
      }
      const mediaType =
        details && "mediaType" in details && typeof details.mediaType === "string"
          ? details.mediaType
          : "";
      if (mediaType === "audio") return "microphone";
      if (mediaType === "video") return "camera";
      return "media";
    }
    case "mediaKeySystem":
      return null;
    case "midi":
    case "midiSysex":
      return "midi";
    case "notifications":
      return "notifications";
    case "openExternal":
      return "openExternal";
    case "pointerLock":
      return "pointerLock";
    case "serial":
      return "serial";
    case "speaker-selection":
      return "speakerSelection";
    case "storage-access":
      return "storageAccess";
    case "top-level-storage-access":
      return "topLevelStorageAccess";
    case "usb":
      return "usb";
    case "window-management":
      return "windowManagement";
    default:
      return null;
  }
}

function permissionMatchesStoredAllow(
  store: BrowserPermissionStore,
  origin: string,
  permission: DesktopBrowserPermission,
): boolean {
  if (store.get(origin, permission) === "allow") {
    return true;
  }
  if (
    permission === "media" &&
    store.get(origin, "camera") === "allow" &&
    store.get(origin, "microphone") === "allow"
  ) {
    return true;
  }
  if (
    (permission === "camera" || permission === "microphone") &&
    store.get(origin, "media") === "allow"
  ) {
    return true;
  }
  return false;
}

function permissionMatchesStoredBlock(
  store: BrowserPermissionStore,
  origin: string,
  permission: DesktopBrowserPermission,
): boolean {
  if (store.get(origin, permission) === "block") {
    return true;
  }
  if (
    permission === "media" &&
    (store.get(origin, "camera") === "block" || store.get(origin, "microphone") === "block")
  ) {
    return true;
  }
  if (
    (permission === "camera" || permission === "microphone") &&
    store.get(origin, "media") === "block"
  ) {
    return true;
  }
  return false;
}

async function promptForPermission(input: {
  readonly getOwnerWindow: () => BrowserWindow | null;
  readonly origin: string;
  readonly permission: DesktopBrowserPermission;
  readonly store: BrowserPermissionStore;
}): Promise<boolean> {
  const permissionLabel = PERMISSION_LABELS[input.permission];
  const originLabel = resolveOriginLabel(input.origin);
  const result = await showBrowserFeatureDialog(input.getOwnerWindow(), {
    type: "question",
    title: "Site permission request",
    message: `${originLabel} wants to use ${permissionLabel}.`,
    buttons: ["Allow once", "Always allow", "Block"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });

  if (result.response === 1) {
    input.store.set(input.origin, input.permission, "allow");
    return true;
  }
  if (result.response === 2) {
    input.store.set(input.origin, input.permission, "block");
    return false;
  }
  return result.response === 0;
}

async function promptForFileSystemAccess(input: {
  readonly details: Electron.FileSystemAccessRestrictedDetails;
  readonly getOwnerWindow: () => BrowserWindow | null;
  readonly store: BrowserPermissionStore;
}): Promise<"allow" | "deny" | "tryAgain"> {
  const origin = parseUrlOrigin(input.details.origin);
  const originLabel = resolveOriginLabel(input.details.origin);
  const targetLabel = input.details.isDirectory ? "folder" : "file";
  const result = await showBrowserFeatureDialog(input.getOwnerWindow(), {
    type: "question",
    title: "File access request",
    message: `${originLabel} wants to access a ${targetLabel}.`,
    detail: input.details.path,
    buttons: ["Allow once", "Always allow", "Deny"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });

  if (origin && result.response === 1) {
    input.store.set(origin, "fileSystem", "allow");
    return "allow";
  }
  if (origin && result.response === 2) {
    input.store.set(origin, "fileSystem", "block");
    return "deny";
  }
  return result.response === 0 ? "allow" : "deny";
}

function getPermissionStoreForActiveSession(): BrowserPermissionStore {
  return getPermissionStore(activeBrowserSessionOptions?.permissionStorePath);
}

function snapshotDownload(id: string, item: Electron.DownloadItem): DesktopBrowserDownload {
  const startedAtMs = item.getStartTime() * 1000;
  const endedAtMs = item.getEndTime() * 1000;
  const savePath = item.getSavePath();
  const percentComplete = item.getPercentComplete();
  return {
    id,
    filename: item.getFilename(),
    url: item.getURL(),
    mimeType: item.getMimeType() || null,
    savePath: savePath.length > 0 ? savePath : null,
    state: item.getState(),
    receivedBytes: item.getReceivedBytes(),
    totalBytes: item.getTotalBytes(),
    percentComplete: Number.isFinite(percentComplete) ? Math.max(0, percentComplete) : 0,
    canResume: item.canResume(),
    paused: item.isPaused(),
    speedBytesPerSecond: item.getCurrentBytesPerSecond(),
    startedAt:
      Number.isFinite(startedAtMs) && startedAtMs > 0 ? new Date(startedAtMs).toISOString() : null,
    endedAt: Number.isFinite(endedAtMs) && endedAtMs > 0 ? new Date(endedAtMs).toISOString() : null,
  };
}

function emitDownloadEvent(
  type: DesktopBrowserDownloadEvent["type"],
  download: DesktopBrowserDownload,
): void {
  retainedDownloadSnapshots.set(download.id, download);
  if (retainedDownloadSnapshots.size > MAX_RETAINED_DOWNLOAD_SNAPSHOTS) {
    const retainedIds = getAllDownloadSnapshots()
      .slice(0, MAX_RETAINED_DOWNLOAD_SNAPSHOTS)
      .map((snapshot) => snapshot.id);
    const retainedIdSet = new Set(retainedIds);
    for (const id of retainedDownloadSnapshots.keys()) {
      if (!retainedIdSet.has(id)) {
        retainedDownloadSnapshots.delete(id);
      }
    }
  }
  activeBrowserSessionOptions?.sendDownloadEvent?.({ type, download });
}

function getAllDownloadSnapshots(): DesktopBrowserDownload[] {
  const latest = new Map(retainedDownloadSnapshots);
  for (const [id, tracked] of trackedDownloads) {
    latest.set(id, tracked.snapshot);
  }
  return Array.from(latest.values()).sort((left, right) =>
    (right.startedAt ?? "").localeCompare(left.startedAt ?? ""),
  );
}

function handleDownloadAction(input: {
  readonly action: DesktopBrowserDownloadAction;
  readonly id: string;
}): boolean {
  const tracked = trackedDownloads.get(input.id);
  const snapshot = tracked?.snapshot ?? retainedDownloadSnapshots.get(input.id);
  try {
    if (input.action === "open") {
      if (!snapshot?.savePath) return false;
      void shell.openPath(snapshot.savePath);
      return true;
    }
    if (input.action === "reveal") {
      if (!snapshot?.savePath) return false;
      shell.showItemInFolder(snapshot.savePath);
      return true;
    }
    if (!tracked) {
      return false;
    }
    if (input.action === "cancel") {
      tracked.item.cancel();
      return true;
    }
    if (input.action === "pause") {
      tracked.item.pause();
      tracked.snapshot = snapshotDownload(input.id, tracked.item);
      emitDownloadEvent("updated", tracked.snapshot);
      return true;
    }
    if (input.action === "resume") {
      tracked.item.resume();
      tracked.snapshot = snapshotDownload(input.id, tracked.item);
      emitDownloadEvent("updated", tracked.snapshot);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function configureInAppBrowserSessionFeatures(
  options: ConfigureInAppBrowserSessionFeaturesOptions,
): Promise<void> {
  const browserSession = session.fromPartition(options.partition);
  activeBrowserSessionOptions = options;
  if (options.userAgent) {
    browserSession.setUserAgent(options.userAgent);
    options.log(
      `browser session user-agent configured value=${sanitizeLogValue(options.userAgent)}`,
    );
  }
  if (configuredBrowserSessions.has(browserSession)) {
    return Promise.resolve();
  }
  configuredBrowserSessions.add(browserSession);
  const permissionStore = getPermissionStore(options.permissionStorePath);

  browserSession.setPermissionCheckHandler(
    (webContents, rawPermission, requestingOrigin, details) => {
      const permission = resolveBrowserPermission(rawPermission, details);
      const origin = resolvePermissionOrigin({ details, requestingOrigin, webContents });
      if (!permission || !origin) {
        return false;
      }
      return permissionMatchesStoredAllow(permissionStore, origin, permission);
    },
  );

  browserSession.setPermissionRequestHandler((webContents, rawPermission, callback, details) => {
    const permission = resolveBrowserPermission(rawPermission, details);
    const origin = resolvePermissionOrigin({ details, webContents });
    if (!permission || !origin) {
      callback(false);
      return;
    }

    if (permissionMatchesStoredAllow(permissionStore, origin, permission)) {
      callback(true);
      return;
    }
    if (permissionMatchesStoredBlock(permissionStore, origin, permission)) {
      callback(false);
      return;
    }

    void (async () => {
      let granted = false;
      try {
        granted = await promptForPermission({
          getOwnerWindow: options.getOwnerWindow,
          origin,
          permission,
          store: permissionStore,
        });
      } catch (error) {
        options.log(
          `browser-permission prompt failed origin=${sanitizeLogValue(origin)} permission=${permission} error=${sanitizeLogValue(formatErrorMessage(error))}`,
        );
      } finally {
        callback(granted);
      }
    })();
  });

  browserSession.setDevicePermissionHandler((details) => {
    const origin = parseUrlOrigin(details.origin);
    if (!origin) {
      return false;
    }
    return permissionStore.get(origin, details.deviceType) === "allow";
  });

  browserSession.on("file-system-access-restricted", (_event, details, callback) => {
    const origin = parseUrlOrigin(details.origin);
    if (origin) {
      const setting = permissionStore.get(origin, "fileSystem");
      if (setting === "allow") {
        callback("allow");
        return;
      }
      if (setting === "block") {
        callback("deny");
        return;
      }
    }

    void (async () => {
      let action: "allow" | "deny" | "tryAgain" = "deny";
      try {
        action = await promptForFileSystemAccess({
          details,
          getOwnerWindow: options.getOwnerWindow,
          store: permissionStore,
        });
      } catch (error) {
        options.log(
          `browser-file-system access prompt failed origin=${sanitizeLogValue(details.origin)} error=${sanitizeLogValue(formatErrorMessage(error))}`,
        );
      } finally {
        callback(action);
      }
    })();
  });

  browserSession.on("will-download", (_event, item) => {
    const id = Crypto.randomUUID();
    item.setSaveDialogOptions({
      defaultPath: Path.join(OS.homedir(), "Downloads", item.getFilename()),
      title: "Save download",
    });

    const tracked = { item, snapshot: snapshotDownload(id, item) };
    trackedDownloads.set(id, tracked);
    retainedDownloadSnapshots.set(id, tracked.snapshot);
    emitDownloadEvent("updated", tracked.snapshot);

    item.on("updated", (_updatedEvent, _state) => {
      tracked.snapshot = snapshotDownload(id, item);
      emitDownloadEvent("updated", tracked.snapshot);
    });
    item.once("done", (_doneEvent, _state) => {
      tracked.snapshot = snapshotDownload(id, item);
      trackedDownloads.delete(id);
      emitDownloadEvent("done", tracked.snapshot);
    });
  });

  browserSession.on("select-webauthn-account", (_event, details, callback) => {
    const relyingPartyId =
      typeof details.relyingPartyId === "string" && details.relyingPartyId.length > 0
        ? details.relyingPartyId
        : "this site";
    const accounts = Array.isArray(details.accounts)
      ? (details.accounts as readonly BrowserWebAuthnAccount[])
      : [];

    void (async () => {
      let selectedCredentialId: string | null = null;
      try {
        selectedCredentialId = await chooseWebAuthnAccount({
          accounts,
          getOwnerWindow: options.getOwnerWindow,
          relyingPartyId,
        });
      } catch (error) {
        options.log(
          `browser-webauthn account selection failed error=${sanitizeLogValue(formatErrorMessage(error))}`,
        );
      } finally {
        callback(selectedCredentialId);
      }
    })();
  });

  browserSession.on("select-hid-device", (event, details, callback) => {
    event.preventDefault();
    const originLabel = resolveFrameOriginLabel(details.frame);
    const choices = details.deviceList.map(formatHidDeviceChoice);

    void (async () => {
      let selectedDeviceId: string | null = null;
      try {
        selectedDeviceId = await chooseBrowserDevice({
          choices,
          deviceKindLabel: "HID device",
          getOwnerWindow: options.getOwnerWindow,
          originLabel,
        });
        const origin =
          details.frame && !details.frame.isDestroyed()
            ? parseUrlOrigin(details.frame.origin || details.frame.url)
            : null;
        if (selectedDeviceId && origin) {
          permissionStore.set(origin, "hid", "allow");
        }
      } catch (error) {
        options.log(
          `browser-hid device selection failed origin=${sanitizeLogValue(originLabel)} error=${sanitizeLogValue(formatErrorMessage(error))}`,
        );
      } finally {
        callback(selectedDeviceId);
      }
    })();
  });

  browserSession.on("select-usb-device", (event, details, callback) => {
    event.preventDefault();
    const originLabel = resolveFrameOriginLabel(details.frame);
    const choices = details.deviceList.map(formatUsbDeviceChoice);

    void (async () => {
      let selectedDeviceId: string | null = null;
      try {
        selectedDeviceId = await chooseBrowserDevice({
          choices,
          deviceKindLabel: "USB device",
          getOwnerWindow: options.getOwnerWindow,
          originLabel,
        });
        const origin =
          details.frame && !details.frame.isDestroyed()
            ? parseUrlOrigin(details.frame.origin || details.frame.url)
            : null;
        if (selectedDeviceId && origin) {
          permissionStore.set(origin, "usb", "allow");
        }
      } catch (error) {
        options.log(
          `browser-usb device selection failed origin=${sanitizeLogValue(originLabel)} error=${sanitizeLogValue(formatErrorMessage(error))}`,
        );
      } finally {
        callback(selectedDeviceId ?? undefined);
      }
    })();
  });

  browserSession.on("select-serial-port", (event, portList, webContents, callback) => {
    event.preventDefault();
    const originLabel = getWebContentsOriginLabel(webContents);
    const choices = portList.map(formatSerialPortChoice);

    void (async () => {
      let selectedPortId: string | null = null;
      try {
        selectedPortId = await chooseBrowserDevice({
          choices,
          deviceKindLabel: "serial port",
          getOwnerWindow: options.getOwnerWindow,
          originLabel,
        });
        const origin = parseUrlOrigin(webContents.getURL());
        if (selectedPortId && origin) {
          permissionStore.set(origin, "serial", "allow");
        }
      } catch (error) {
        options.log(
          `browser-serial port selection failed origin=${sanitizeLogValue(originLabel)} error=${sanitizeLogValue(formatErrorMessage(error))}`,
        );
      } finally {
        callback(selectedPortId ?? "");
      }
    })();
  });

  return loadBrowserExtensions({
    browserSession,
    directories: options.extensionDirectories ?? [],
    log: options.log,
  }).then(() => {
    options.log("browser session feature handlers configured");
  });
}

async function loadBrowserExtensions(input: {
  readonly browserSession: Electron.Session;
  readonly directories: readonly string[];
  readonly log: (message: string) => void;
}): Promise<void> {
  const directories = input.directories
    .map((directory) => directory.trim())
    .filter((directory) => directory.length > 0);
  if (directories.length === 0) {
    return;
  }

  await Promise.all(
    directories.map(async (directory) => {
      try {
        const extension = await withTimeout(
          input.browserSession.loadExtension(directory, { allowFileAccess: true }),
          BROWSER_EXTENSION_LOAD_TIMEOUT_MS,
          `Timed out loading browser extension after ${String(BROWSER_EXTENSION_LOAD_TIMEOUT_MS)}ms.`,
        );
        input.log(
          `browser-extension loaded name=${sanitizeLogValue(extension.name)} id=${sanitizeLogValue(extension.id)}`,
        );
      } catch (error: unknown) {
        input.log(
          `browser-extension load failed path=${sanitizeLogValue(directory)} error=${sanitizeLogValue(formatErrorMessage(error))}`,
        );
      }
    }),
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function getInAppBrowserSiteInfo(input: {
  readonly partition: string;
  readonly url: string;
}): Promise<DesktopBrowserSiteInfo | null> {
  const origin = parseUrlOrigin(input.url);
  if (!origin) {
    return null;
  }

  const browserSession = session.fromPartition(input.partition);
  const permissionStore = getPermissionStoreForActiveSession();
  const cookies = await browserSession.cookies.get({ url: origin });
  const downloads = getAllDownloadSnapshots();
  return {
    url: input.url,
    origin: resolveOriginLabel(origin),
    storageOrigin: origin,
    permissions: permissionStore.list(origin),
    cookieCount: cookies.length,
    userAgent: browserSession.getUserAgent(),
    downloads,
    activeDownloads: downloads.filter((download) => download.state === "progressing").length,
  };
}

export async function clearInAppBrowserSiteData(input: {
  readonly partition: string;
  readonly url: string;
}): Promise<boolean> {
  const origin = parseUrlOrigin(input.url);
  if (!origin) {
    return false;
  }
  const browserSession = session.fromPartition(input.partition);
  await browserSession.clearStorageData({ origin });
  await browserSession.clearData({
    dataTypes: [
      "backgroundFetch",
      "cache",
      "cookies",
      "downloads",
      "fileSystems",
      "indexedDB",
      "localStorage",
      "serviceWorkers",
      "webSQL",
    ],
    origins: [origin],
  });
  return true;
}

export function resetInAppBrowserSitePermissions(input: { readonly url: string }): boolean {
  const origin = parseUrlOrigin(input.url);
  if (!origin) {
    return false;
  }
  return getPermissionStoreForActiveSession().reset(origin);
}

export function setInAppBrowserSitePermission(input: {
  readonly permission: DesktopBrowserPermission;
  readonly setting: DesktopBrowserPermissionSetting;
  readonly url: string;
}): boolean {
  const origin = parseUrlOrigin(input.url);
  if (
    !origin ||
    !isBrowserPermission(input.permission) ||
    !isBrowserPermissionSetting(input.setting)
  ) {
    return false;
  }
  return getPermissionStoreForActiveSession().set(origin, input.permission, input.setting);
}

export function getInAppBrowserDownloads(): DesktopBrowserDownload[] {
  return getAllDownloadSnapshots();
}

export function controlInAppBrowserDownload(input: {
  readonly action: DesktopBrowserDownloadAction;
  readonly id: string;
}): boolean {
  if (
    input.action !== "cancel" &&
    input.action !== "open" &&
    input.action !== "pause" &&
    input.action !== "resume" &&
    input.action !== "reveal"
  ) {
    return false;
  }
  return handleDownloadAction(input);
}
