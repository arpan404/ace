import type { NetworkInterfaceInfo } from "node:os";
import { expect, it } from "vitest";
import { readConfig } from "./config.ts";
import { remoteListener } from "./network.ts";

const ipv4 = (address: string): NetworkInterfaceInfo => ({
  address,
  netmask: "255.255.255.0",
  family: "IPv4",
  mac: "00:00:00:00:00:00",
  internal: false,
  cidr: `${address}/24`,
});
const identity = () => ({ key: Buffer.from(""), cert: Buffer.from(""), fingerprint: "pin" });

const interfaces = () => ({
  "vEthernet (WSL (Hyper-V firewall))": [ipv4("172.29.96.1")],
  "VirtualBox Host-Only Network": [ipv4("192.168.56.1")],
  Ethernet: [ipv4("169.254.10.2")],
  "Wi-Fi": [ipv4("192.168.1.20")],
});

it.runIf(process.platform === "win32")(
  "on Windows, LAN pairing links skip Hyper-V, WSL and VM adapters for the real one",
  async () => {
    const config = readConfig({ ACE_HOME: "C:\\ace-home", ACE_LISTEN: "lan" }, "C:\\");
    const listener = await remoteListener(config, {
      interfaces,
      status: async () => "",
      identity,
    });
    expect(listener).toMatchObject({ host: "0.0.0.0", advertisedHost: "192.168.1.20" });
    const pinned = await remoteListener(
      readConfig(
        { ACE_HOME: "C:\\ace-home", ACE_LISTEN: "lan", ACE_ADVERTISE_HOST: "10.0.0.5" },
        "C:\\",
      ),
      { interfaces, status: async () => "", identity },
    );
    expect(pinned?.advertisedHost).toBe("10.0.0.5");
  },
);
