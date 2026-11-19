import type { NetworkInterfaceInfo } from "node:os";
import { expect, it } from "vitest";
import { readConfig } from "./config.ts";
import { remoteListener } from "./network.ts";

const windows = process.platform === "win32";
const ipv4 = (address: string, mac: string): NetworkInterfaceInfo => ({
  address,
  netmask: "255.255.255.0",
  family: "IPv4",
  mac,
  internal: false,
  cidr: `${address}/24`,
});
const identity = () => ({ key: Buffer.from(""), cert: Buffer.from(""), fingerprint: "pin" });
const lan = (extra: Record<string, string> = {}) =>
  readConfig({ ACE_HOME: "C:\\ace-home", ACE_LISTEN: "lan", ...extra }, "C:\\");
const listen = (
  interfaces: Record<string, NetworkInterfaceInfo[]>,
  config: ReturnType<typeof lan> = lan(),
) => remoteListener(config, { interfaces: () => interfaces, status: async () => "", identity });

const wsl = { "vEthernet (WSL (Hyper-V firewall))": [ipv4("172.29.96.1", "00:15:5d:01:02:03")] };
const apipa = { Ethernet: [ipv4("169.254.10.2", "3c:7c:3f:11:22:33")] };

it.runIf(windows)(
  "on Windows, LAN pairing links skip Hyper-V, WSL and VM adapters, even renamed ones, for the real one",
  async () => {
    const interfaces = {
      ...wsl,
      "VirtualBox Host-Only Network": [ipv4("192.168.56.1", "0a:00:27:00:00:0c")],
      // A Hyper-V switch someone renamed: only its vendor prefix gives it away.
      "Ethernet 2": [ipv4("10.20.0.1", "00:15:5d:aa:bb:cc")],
      // A tunnel adapter with no hardware address.
      "Ethernet 3": [ipv4("10.8.0.2", "00:00:00:00:00:00")],
      ...apipa,
      "Wi-Fi": [ipv4("192.168.1.20", "a4:83:e7:12:34:56")],
    };
    expect(await listen(interfaces)).toMatchObject({
      host: "0.0.0.0",
      advertisedHost: "192.168.1.20",
    });
    const pinned = await listen(interfaces, lan({ ACE_ADVERTISE_HOST: "10.0.0.5" }));
    expect(pinned?.advertisedHost).toBe("10.0.0.5");
  },
);

it.runIf(windows)(
  "on Windows inside a virtual machine, its only network card is used even though the hypervisor made it",
  async () => {
    expect(
      await listen({ ...wsl, Ethernet0: [ipv4("192.168.116.133", "00:0c:29:4f:8e:35")] }),
    ).toMatchObject({ advertisedHost: "192.168.116.133" });
  },
);

it.runIf(windows)(
  "on Windows, with only a WSL or only a link-local address, LAN access asks for ACE_ADVERTISE_HOST instead of advertising it",
  async () => {
    for (const interfaces of [wsl, apipa, { ...wsl, ...apipa }])
      await expect(listen(interfaces)).rejects.toThrow(/ACE_ADVERTISE_HOST/);
    // Setting it is the way out.
    expect((await listen(wsl, lan({ ACE_ADVERTISE_HOST: "192.168.1.20" })))?.advertisedHost).toBe(
      "192.168.1.20",
    );
  },
);
