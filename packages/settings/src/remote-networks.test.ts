import { readFile, writeFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { SettingsService } from "./service.ts";
import { fixture } from "./test-support.ts";

const networks = async (f: Awaited<ReturnType<typeof fixture>>) => ({
  lan: (await f.service.get("remote.lan")).value,
  tailscale: (await f.service.get("remote.tailscale")).value,
  relay: (await f.service.get("remote.relay")).value,
});

test.each([
  { transport: "local", relayUrl: "", lan: true, tailscale: false, relay: false },
  { transport: "lan", relayUrl: "", lan: true, tailscale: false, relay: false },
  { transport: "tailscale", relayUrl: "", lan: false, tailscale: true, relay: false },
  {
    transport: "relay",
    relayUrl: "wss://relay.example.com/",
    lan: true,
    tailscale: false,
    relay: true,
  },
  { transport: "relay", relayUrl: "", lan: true, tailscale: false, relay: true },
  // A saved relay address ran its relay whatever the transport.
  {
    transport: "tailscale",
    relayUrl: "wss://relay.example.com/",
    lan: false,
    tailscale: true,
    relay: true,
  },
])(
  "a file saved with transport $transport and relay '$relayUrl' keeps the networks it served",
  async ({ transport, relayUrl, ...expected }) => {
    const f = await fixture();
    try {
      await writeFile(
        f.globalPath,
        JSON.stringify({
          version: 2,
          settings: {
            "remote.enabled": true,
            "remote.transport": transport,
            ...(relayUrl ? { "remote.relayUrl": relayUrl } : {}),
          },
        }),
      );
      expect(await networks(f)).toEqual(expected);
      expect((await f.service.get("remote.enabled")).value).toBe(true);
      const saved = JSON.parse(await readFile(f.globalPath, "utf8")).settings;
      expect(saved).not.toHaveProperty(["remote.transport"]);
      expect(saved).toMatchObject({
        "remote.lan": expected.lan,
        "remote.tailscale": expected.tailscale,
        "remote.relay": expected.relay,
      });
    } finally {
      await f.close();
    }
  },
);

test("a relay address saved before networks were settings keeps its relay on beside the LAN", async () => {
  const f = await fixture();
  try {
    await writeFile(
      f.globalPath,
      JSON.stringify({ version: 2, settings: { "remote.relayUrl": "wss://relay.example.com/" } }),
    );
    expect(await networks(f)).toEqual({ lan: true, tailscale: false, relay: true });
  } finally {
    await f.close();
  }
});

test("an older app choosing Tailscale over the wire moves this machine to Tailscale only", async () => {
  const f = await fixture();
  try {
    await f.service.set("remote.lan", true, { kind: "global" });
    await f.service.set("remote.relay", false, { kind: "global" });
    await f.service.set("remote.transport", "tailscale", { kind: "global" });
    expect(await networks(f)).toEqual({ lan: false, tailscale: true, relay: false });
    expect(JSON.parse(await readFile(f.globalPath, "utf8")).settings).not.toHaveProperty([
      "remote.transport",
    ]);
  } finally {
    await f.close();
  }
});

test("networks chosen after the change are not rewritten by a later relay address", async () => {
  const f = await fixture();
  try {
    await f.service.set("remote.relay", false, { kind: "global" });
    await f.service.set("remote.relayUrl", "wss://relay.example.com/", { kind: "global" });
    expect(await networks(f)).toEqual({ lan: true, tailscale: false, relay: false });
  } finally {
    await f.close();
  }
});

test("remote access is on in a fresh home, and a saved off stays off after a restart", async () => {
  const f = await fixture();
  try {
    expect(await f.service.get("remote.enabled")).toMatchObject({
      value: true,
      provenance: "defaults",
    });
    expect(await networks(f)).toEqual({ lan: true, tailscale: false, relay: false });
    await f.service.set("remote.enabled", false, { kind: "global" });
    await f.service.close();
    const restarted = new SettingsService({ dataDir: f.dataDir, io: f.edges.io });
    try {
      expect(await restarted.get("remote.enabled")).toMatchObject({
        value: false,
        provenance: "global",
      });
    } finally {
      await restarted.close();
    }
  } finally {
    await f.close();
  }
});
