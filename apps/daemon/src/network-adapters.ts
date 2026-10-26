import type { networkInterfaces } from "node:os";

/** Adapters named for a hypervisor, VPN or tunnel, as Windows names them by default. */
const virtualNames =
  /vethernet|hyper-v|wsl|virtualbox|vmware|vmnet|loopback|bluetooth|tailscale|zerotier|wireguard|vpn|teredo|isatap/i;

/**
 * Vendor prefixes (OUIs) hypervisors give their virtual adapters: Hyper-V and WSL, VMware,
 * VirtualBox, Parallels, Xen, QEMU.
 */
const virtualVendors = new Set([
  "00:15:5d",
  "00:50:56",
  "00:0c:29",
  "00:05:69",
  "00:1c:14",
  "08:00:27",
  "0a:00:27",
  "00:1c:42",
  "00:16:3e",
  "52:54:00",
]);

/**
 * Windows lists Hyper-V, WSL, VPN and VM adapters beside the real one, often first. Pairing links
 * name an IPv4 address of an adapter that isn't virtual by name, has a hardware address (tunnels
 * have none) and isn't link-local. One from a hypervisor's vendor loses to any other, so a renamed
 * Hyper-V switch (`Ethernet 2`) never beats Wi-Fi, yet inside a virtual machine, where the only
 * card is the hypervisor's, it is still used. Throws when nothing qualifies, rather than advertise
 * an address other devices can't reach; ACE_ADVERTISE_HOST is the way out.
 */
export function windowsLanAddress(interfaces: ReturnType<typeof networkInterfaces>): string {
  const usable = Object.entries(interfaces)
    .filter(([name]) => !virtualNames.test(name))
    .flatMap(([, entries]) => entries ?? [])
    .filter(
      (candidate) =>
        !candidate.internal &&
        candidate.family === "IPv4" &&
        !candidate.address.startsWith("169.254.") &&
        candidate.mac !== "00:00:00:00:00:00",
    );
  const physical = usable.find(
    (candidate) => !virtualVendors.has(candidate.mac.slice(0, 8).toLowerCase()),
  );
  const chosen = physical ?? usable[0];
  if (chosen) return chosen.address;
  throw new Error(
    "No LAN address found: this computer is connected only through virtual, VPN or link-local adapters. Set ACE_ADVERTISE_HOST to its LAN address.",
  );
}
