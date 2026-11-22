import { expect, test } from "vitest";
import { APP_SOCKET_HEADER, AppSocketTag } from "@ace/protocol";
import { TAG_FRESH_MS, tagFresh } from "@ace/account-grant/app-channel";
import { appSocketTags, type UpgradeHook } from "./app-socket-tags.ts";
import { keptKeyGate, keptKeyRefusal, type GateFacts } from "./app-standing-gate.ts";

/*
 * Where the device key may be kept (ADR 0190, amendment 1), and which sockets main tags for it.
 */

const release: GateFacts = {
  platform: "darwin",
  packaged: true,
  userData: "/Users/me/Library/Application Support/ace desktop",
  defaultUserData: "/Users/me/Library/Application Support/ace desktop",
  profileOverridden: false,
  debugging: false,
  sealing: true,
};

test("only a packaged app on its own profile, without debugging, with a sealing store keeps a key", () => {
  expect(keptKeyRefusal(release)).toBeUndefined();
  for (const facts of [
    { ...release, packaged: false },
    { ...release, debugging: true },
    { ...release, profileOverridden: true },
    { ...release, userData: "/tmp/other-profile" },
    { ...release, platform: "linux" as const, sealing: false },
  ])
    expect(keptKeyRefusal(facts)).toBeDefined();
});

test("on macOS the running bundle must be ace's release signature; Windows and Linux rely on their stores", async () => {
  expect(await keptKeyGate(release, async () => false)()).toBe(false);
  expect(await keptKeyGate(release, async () => true)()).toBe(true);
  expect(await keptKeyGate(release, () => Promise.reject(new Error("codesign missing")))()).toBe(
    false,
  );
  for (const platform of ["win32", "linux"] as const)
    expect(await keptKeyGate({ ...release, platform }, async () => false)()).toBe(true);
  expect(await keptKeyGate({ ...release, packaged: false }, async () => true)()).toBe(false);
});

/** Electron's hook, driven by the test: each upgrade's headers as main sends them on. */
function hook() {
  let listener: Parameters<UpgradeHook["onBeforeSendHeaders"]>[1] | undefined;
  return {
    hook: {
      onBeforeSendHeaders: (_filter, next) => {
        listener = next;
      },
    } satisfies UpgradeHook,
    send(url: string, resourceType: string, requestHeaders: Record<string, string> = {}) {
      let sent: Record<string, string> = {};
      listener?.({ url, resourceType, requestHeaders }, (response) => {
        sent = response.requestHeaders;
      });
      return sent;
    },
  };
}

test("main tags only the app's own transport: its daemon's exact address, from the app's own pages", () => {
  const h = hook();
  let enabled = true;
  let next = 0;
  const tags = appSocketTags({
    hook: h.hook,
    daemonUrl: () => "ws://127.0.0.1:4100/",
    appOrigin: () => "app://ace",
    enabled: () => enabled,
    tag: () => `tag-${++next}`,
  });
  const app = { Origin: "app://ace" };
  expect(h.send("ws://127.0.0.1:4100/", "webSocket", app)[APP_SOCKET_HEADER]).toBe("tag-1");
  for (const [url, type, headers] of [
    // Another loopback server, another path on the daemon, a plain request.
    ["ws://127.0.0.1:5173/", "webSocket", app],
    ["ws://127.0.0.1:4100/tunnel", "webSocket", app],
    ["ws://127.0.0.1:4100/?x=1", "webSocket", app],
    ["ws://127.0.0.1:4100/", "xhr", app],
    // A page at another origin in the same session, or none named.
    ["ws://127.0.0.1:4100/", "webSocket", { Origin: "http://localhost:5173" }],
    ["ws://127.0.0.1:4100/", "webSocket", {}],
  ] as const)
    expect(h.send(url, type, { ...headers })[APP_SOCKET_HEADER], url).toBeUndefined();
  // A page trying to set the header itself never gets it through.
  expect(
    h.send("ws://127.0.0.1:5173/", "webSocket", { ...app, [APP_SOCKET_HEADER]: "forged" })[
      APP_SOCKET_HEADER
    ],
  ).toBeUndefined();
  enabled = false;
  expect(h.send("ws://127.0.0.1:4100/", "webSocket", app)[APP_SOCKET_HEADER]).toBeUndefined();
  expect(tags.recent()).toEqual(["tag-1"]);
});

test("a tag carries when main made it, so the daemon takes it only while fresh", () => {
  const h = hook();
  appSocketTags({
    hook: h.hook,
    daemonUrl: () => "ws://127.0.0.1:4100/",
    appOrigin: () => "app://ace",
    enabled: () => true,
  });
  const before = Date.now();
  const tag = h.send("ws://127.0.0.1:4100/", "webSocket", { Origin: "app://ace" })[
    APP_SOCKET_HEADER
  ];
  expect(AppSocketTag.safeParse(tag).success).toBe(true);
  expect(tagFresh(tag ?? "", before)).toBe(true);
  expect(tagFresh(tag ?? "", before + TAG_FRESH_MS + 1_000)).toBe(false);
});
