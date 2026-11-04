import { MachinePath, type RemoteAccessStatus } from "@ace/protocol";

const serving = (network: { state: string; address?: string | undefined }) =>
  network.state === "on" ? network.address : undefined;

/**
 * The paths this machine serves right now, for clients already connected and authenticated
 * (ADR 0114): its TLS listener on the same computer, the LAN and Tailscale, each pinned to the
 * listener's public-key fingerprint, and each relay it is on, pinned to its relay host key.
 * None of it is secret; it only says where the machine answers and how to prove it is this one.
 */
export function machinePaths(
  status: RemoteAccessStatus,
  /** The direct listener's public-key fingerprint, while it serves. */
  directFingerprint: string | undefined,
): MachinePath[] {
  const paths: MachinePath[] = [];
  const add = (candidate: unknown) => {
    const path = MachinePath.safeParse(candidate);
    if (path.success && !paths.some((known) => known.url === path.data.url)) paths.push(path.data);
  };
  const networks = status.networks;
  if (!networks) return paths;
  const lan = serving(networks.lan);
  const tailscale = serving(networks.tailscale);
  if (directFingerprint) {
    // The LAN listener binds every address, the loopback one included.
    if (lan) {
      const port = URL.parse(lan)?.port;
      if (port)
        add({ kind: "loopback", url: `https://127.0.0.1:${port}`, fingerprint: directFingerprint });
      add({ kind: "lan", url: lan, fingerprint: directFingerprint });
    }
    if (tailscale) add({ kind: "tailscale", url: tailscale, fingerprint: directFingerprint });
  }
  const relayHostId = status.relay?.fingerprint;
  if (relayHostId) {
    // ace's relay first: when the person named it as theirs too, it is one registration.
    const account = serving(networks.account);
    if (account) add({ kind: "account", url: account, relayHostId });
    const relay = serving(networks.relay);
    if (relay) add({ kind: "relay", url: relay, relayHostId });
  }
  return paths;
}
