import type { UserBrowserExtensionMessage } from "@ace/protocol";
import type { ChromeApi, ChromePort } from "./chrome-api.ts";
import { Controller } from "./controller.ts";
import { browserFamily, type Brand } from "./identity.ts";
import { decodeFromHost, decodePopupRequest } from "./wire.ts";

/** Mirrors `userBrowserHostName` and the protocol version; imported values would bundle zod. */
const hostName = "dev.ace.user_browser";
const protocolVersion = 1;

declare const chrome: ChromeApi;
declare const navigator: { userAgentData?: { brands?: Brand[] } };

let port: ChromePort | undefined;
let retry = 0;
let registerId = 0;
const post = (message: UserBrowserExtensionMessage) => {
  try {
    port?.postMessage(message);
  } catch {
    // The port closed under us; onDisconnect handles the rest.
  }
};
const controller = new Controller(chrome, post);

/**
 * A new profile's id is used at once and saved meanwhile: the first write to a new profile's
 * storage can wait seconds on the disk. Should it never land, the browser closed with it and the
 * next start registers a new id; ace keeps nothing under the old one.
 */
async function profileId(): Promise<string> {
  const stored = (await chrome.storage.local.get("profileId")).profileId;
  if (typeof stored === "string" && stored) return stored;
  const created = crypto.randomUUID();
  void chrome.storage.local.set({ profileId: created }).catch(() => {});
  return created;
}
/**
 * Read once, starting as the worker starts, so it overlaps starting the host and reaching ace
 * instead of following them; the worker keeps the one id for its lifetime.
 */
let profile: Promise<string> | undefined;
const ownProfile = (): Promise<string> =>
  (profile ??= profileId().catch((error: unknown) => {
    profile = undefined;
    throw error;
  }));

async function register(): Promise<void> {
  const { family, version } = browserFamily(navigator.userAgentData?.brands ?? []);
  post({
    type: "user_browser.register",
    requestId: `register-${++registerId}`,
    version: protocolVersion,
    browser: {
      family,
      version,
      profileId: await ownProfile(),
      extensionVersion: chrome.runtime.getManifest().version,
    },
  });
}

async function received(raw: unknown): Promise<void> {
  const message = decodeFromHost(raw);
  if (!message) return;
  if (message.type === "user_browser.link") {
    await controller.link(message.state, message.detail);
    if (message.state === "connected") await register();
    return;
  }
  if (message.type === "user_browser.registered") {
    retry = 0;
    await controller.registered();
    return;
  }
  try {
    const result = await controller.command(message.operation);
    post({ type: "user_browser.reply", id: message.id, ok: true, result: result ?? null });
  } catch (error) {
    post({
      type: "user_browser.reply",
      id: message.id,
      ok: false,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 2048),
    });
  }
}

/** One native host per profile; it lives as long as this port, and keeps this worker alive. */
function connect(): void {
  const current = chrome.runtime.connectNative(hostName);
  port = current;
  void controller.link("connecting");
  current.onMessage.addListener((message) => void received(message));
  current.onDisconnect.addListener(() => {
    if (port !== current) return;
    port = undefined;
    void controller.link("offline");
    // The host is missing or exited: try again, slower each time, up to a minute.
    const delay = Math.min(60_000, 2_000 * 2 ** Math.min(retry++, 5));
    setTimeout(connect, delay);
  });
}

chrome.runtime.onMessage.addListener((raw, _sender, respond) => {
  const request = decodePopupRequest(raw);
  if (!request) return false;
  const work =
    request.kind === "share"
      ? controller.share(request.tabId)
      : request.kind === "unshare"
        ? controller.unshare(request.tabId)
        : request.kind === "stop"
          ? controller.stop()
          : Promise.resolve();
  void work
    .then(() => controller.state())
    .then(
      (state) => respond({ ok: true, state }),
      (error: unknown) =>
        respond({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
  return true;
});

void chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
void ownProfile().catch(() => {});
connect();
