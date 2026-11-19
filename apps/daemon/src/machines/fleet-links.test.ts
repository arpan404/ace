import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { pairingLinkUrl } from "@ace/client/access";
import { Device, HostId, type DeviceCredential } from "@ace/protocol";
import { Profiles } from "../cli/profiles.ts";
import { FleetLinks, profileSlug } from "./fleet-links.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

it("a linked machine's profile name is its display name in slug form, never local or a taken one", () => {
  expect(profileSlug("Studio Mac Pro", [])).toBe("studio-mac-pro");
  expect(profileSlug("Studio", ["studio", "studio-2"])).toBe("studio-3");
  expect(profileSlug("Local", [])).toBe("local-2");
  expect(profileSlug("☁️", [])).toBe("machine");
  expect(profileSlug("x".repeat(80), [])).toMatch(/^[a-z0-9-]{1,64}$/);
});

const studio = HostId.parse("host-studio");
const pairing = (code: string, scopes: string[]) =>
  pairingLinkUrl({
    daemon: "https://studio.local:5870/",
    fingerprint: "a".repeat(64),
    code,
    scopes,
  });
const credential = (id: string, scopes: string[]): DeviceCredential => ({
  device: Device.parse({
    id,
    name: "MacBook",
    scopes,
    createdAt: 1,
    lastSeenAt: 1,
    revokedAt: null,
  }),
  token: id.at(-1)?.repeat(64) ?? "0".repeat(64),
});

/** Links kept in a real profile table; each redemption waits until the test lets it finish. */
async function fleet() {
  const home = await mkdtemp(join(tmpdir(), "ace-fleet-links-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const redeemed: string[] = [];
  const waiting: (() => void)[] = [];
  const links = new FleetLinks({
    profiles: () => new Profiles(home),
    describe: async () => {
      throw new Error("offline");
    },
    redeem: async (url) => {
      redeemed.push(url);
      await new Promise<void>((resolve) => waiting.push(resolve));
      const scopes = new URLSearchParams(new URL(url).hash.slice(1)).get("scopes") ?? "";
      return credential(`device-${redeemed.length}`, scopes.split(","));
    },
    hostName: async () => "MacBook",
  });
  const saved = () => {
    const profiles = new Profiles(home);
    try {
      return profiles.list().map((profile) => profile.deviceId);
    } finally {
      profiles.close();
    }
  };
  return { links, redeemed, saved, finish: () => waiting.splice(0).forEach((go) => go()) };
}

it("filling a gap never redeems over a link to that machine made meanwhile, and says so", async () => {
  const { links, redeemed, saved, finish } = await fleet();
  // Another window links with Projects; it is still redeeming when Link all fills the gap.
  const first = links.link({
    pairingUrl: pairing("code-projects", ["read", "operate", "projects"]),
    hostId: studio,
    name: "Studio",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await expect(
    links.link({
      pairingUrl: pairing("code-operate", ["read", "operate"]),
      hostId: studio,
      name: "Studio",
      keep: true,
    }),
  ).rejects.toMatchObject({ code: "exists" });
  finish();
  await first;
  // Once it is saved, the same gap filled again is refused the same way.
  await expect(
    links.link({
      pairingUrl: pairing("code-operate-2", ["read", "operate"]),
      hostId: studio,
      name: "Studio",
      keep: true,
    }),
  ).rejects.toMatchObject({ code: "exists" });
  // Only the link with Projects was ever redeemed there, and it is the one kept.
  expect(redeemed).toHaveLength(1);
  expect(saved()).toEqual(["device-1"]);
});

it("a link made again on purpose still replaces the one held", async () => {
  const { links, saved, finish } = await fleet();
  const made = (code: string) =>
    links.link({ pairingUrl: pairing(code, ["read", "operate"]), hostId: studio, name: "Studio" });
  const first = made("code-1");
  await new Promise((resolve) => setTimeout(resolve, 10));
  finish();
  await first;
  const again = made("code-2");
  await new Promise((resolve) => setTimeout(resolve, 10));
  finish();
  await again;
  expect(saved()).toEqual(["device-2"]);
});
