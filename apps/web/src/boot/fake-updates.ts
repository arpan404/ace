import { FakeDaemon } from "@ace/fake-daemon";
import type { MachineUpdate } from "@ace/protocol";

/*
 * `?fakeWorld=updates`: a fleet with a release out. This Mac and the build server can update
 * with a Windows PC (whose download fails), a Linux laptop on the AppImage and a Linux server
 * on the standalone daemon. An iMac is up to date, a deb install updates from its release
 * page, a Mac mini's app is closed, this window only reads a kitchen Mac, and the dev world's
 * old laptop is offline. Updates
 * step every 1.5 s; `?fakeUpdates=still` holds them so each state can be looked at, and
 * `aceFakeUpdates.get(hostId)` reaches each machine's daemon from the console.
 */

const release = (version: string) => `https://github.com/arpan404/ace/releases/tag/v${version}`;

const offer = (fields: Partial<MachineUpdate>): Partial<MachineUpdate> => ({
  version: "0.0.18",
  state: "available",
  available: "0.0.19",
  releaseUrl: release("0.0.19"),
  checkedAt: Date.now() - 20 * 60_000,
  ...fields,
});

interface Peer {
  hostId: string;
  name: string;
  update: Partial<MachineUpdate>;
  fails?: string;
  readOnly?: boolean;
}

const peers: readonly Peer[] = [
  {
    hostId: "windows-pc",
    name: "Windows PC",
    update: offer({ platform: "win32", arch: "x64", install: "desktop" }),
    fails: "The installer couldn't replace ace.exe while it was open.",
  },
  {
    hostId: "linux-laptop",
    name: "Linux laptop",
    update: offer({ platform: "linux", arch: "x64", install: "desktop" }),
  },
  {
    hostId: "linux-server",
    name: "Linux server",
    update: offer({ platform: "linux", arch: "x64", install: "standalone" }),
  },
  {
    hostId: "imac",
    name: "iMac",
    update: offer({ version: "0.0.19", state: "none", available: null, install: "desktop" }),
  },
  {
    hostId: "deb-box",
    name: "Deb box",
    update: offer({
      platform: "linux",
      arch: "arm64",
      install: "desktop",
      blocked: "release-page",
    }),
  },
  {
    hostId: "mac-mini",
    name: "Mac mini",
    update: offer({ install: "desktop", blocked: "app-closed" }),
  },
  { hostId: "kitchen-mac", name: "Kitchen Mac", update: offer({}), readOnly: true },
];

/** The machines this world adds to the pool, with This Mac's and the build server's updates. */
export function seedFleetUpdates(own: FakeDaemon, server: FakeDaemon) {
  const still =
    new URLSearchParams(globalThis.location?.search ?? "").get("fakeUpdates") === "still";
  const timer = {
    set(delayMs: number, callback: () => void) {
      const handle = setTimeout(callback, delayMs);
      return () => clearTimeout(handle);
    },
  };
  own.machineUpdate.seed(offer({ install: "desktop", busy: 1 }));
  server.machineUpdate.seed(
    offer({ platform: "linux", arch: "x64", install: "standalone", busy: 2 }),
  );
  const daemons = peers.map((peer) => {
    const daemon = new FakeDaemon({
      clock: () => Date.now(),
      hostId: peer.hostId,
      displayName: peer.name,
      ...(peer.readOnly ? { deviceScopes: { "web-fake-device": ["read"] } } : {}),
    });
    daemon.machineUpdate.seed(peer.update, peer.fails ? { fails: peer.fails } : {});
    return daemon;
  });
  const all = [own, server, ...daemons];
  // Linked with each other, as Link all leaves them, so the rows talk only about updates.
  for (const from of all)
    for (const to of all) if (from !== to && to.hostId !== "kitchen-mac") from.linkTo(to);
  if (!still) for (const daemon of all) daemon.machineUpdate.autoplay(timer, 1500);
  Object.assign(globalThis, {
    aceFakeUpdates: new Map(all.map((daemon) => [daemon.hostId, daemon])),
  });
  return daemons;
}
