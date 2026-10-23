import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Check, CheckResult } from "@ace/diagnostics";
import { remoteListener, urlHost } from "../network.ts";
import { remotePlan } from "../remote-policy.ts";
import { remoteAccessPorts, type RemoteAccessPorts } from "./remote-access-facts.ts";
import type { DoctorContext, DoctorFeature } from "./feature.ts";

const day = 24 * 60 * 60 * 1000;
const renewWithinMs = 14 * day;
const accessFix = "Change remote access in Settings › Remote.";
const tailscaleFix =
  "Install Tailscale, sign in and connect, or switch remote access to LAN in Settings › Remote.";
const BackendState = z.object({ BackendState: z.string().max(64) });
const CertificateNames = z.object({
  Self: z.object({ DNSName: z.string().max(512) }),
  CertDomains: z.array(z.string().max(512)).nullish(),
});
const httpsFix =
  "Turn on HTTPS Certificates on the DNS page of the Tailscale admin console. ace picks the certificate up on its own.";

/** The daemon's plan, plus whether the relay was chosen without an address to reach it. */
type Plan = ReturnType<typeof remotePlan> & { relayMissing: boolean };
type Verdict = Omit<CheckResult, "id">;

/**
 * Remote access as the daemon would start it: which transport, whether Tailscale is up when
 * it's the one in use, and the expiry of the TLS certificate devices connect to. Reads only
 * the public certificate, never the private key beside it.
 */
export function remoteAccessFeature(ports: RemoteAccessPorts = remoteAccessPorts): DoctorFeature {
  return {
    id: "remote",
    checks(context) {
      let plan: Promise<Plan> | undefined;
      const load = () =>
        (plan ??= ports.preferences(context).then((saved) => {
          const planned = remotePlan(context.config, saved);
          const relayMissing =
            saved["remote.enabled"] && saved["remote.transport"] === "relay" && !planned.relayUrl;
          return { ...planned, relayMissing };
        }));
      return [
        accessCheck(context, ports, load),
        certificateCheck(context, load),
        tailscaleHttpsCheck(ports, load),
      ];
    },
  };
}

export const remoteAccess: DoctorFeature = remoteAccessFeature();

function accessCheck(
  context: DoctorContext,
  ports: RemoteAccessPorts,
  load: () => Promise<Plan>,
): Check {
  return {
    id: "remote.access",
    fix: accessFix,
    async run() {
      const plan = await load();
      if (plan.listen === "local" && !plan.relayUrl)
        return { status: "ok", message: "Remote access is off", fix: accessFix };
      if (plan.relayMissing)
        return {
          status: "warn",
          message: "Remote access is set to use a relay, but no relay address is saved",
          fix: "Enter your self-hosted relay address in Settings › Remote, or pick another transport.",
        };
      const extras = [
        ...(plan.relayUrl ? [`relay ${relayHost(plan.relayUrl)}`] : []),
        ...devices(ports.pairedDevices(context)),
      ];
      const direct =
        plan.listen === "local" ? undefined : await directListener(context, ports, plan);
      if (direct && direct.status !== "ok")
        return { ...direct, message: [direct.message, ...extras].join(" · ") };
      return {
        status: "ok",
        message: `Remote access is on: ${[...(direct ? [direct.message] : []), ...extras].join(" · ")}`,
        fix: accessFix,
      };
    },
  };
}

/** Resolves the listening address with the daemon's own rules; never binds or reads keys. */
async function directListener(
  context: DoctorContext,
  ports: RemoteAccessPorts,
  plan: Plan,
): Promise<Verdict> {
  if (plan.listen === "tailscale" && !(await ports.tailscale(context)))
    return {
      status: "warn",
      message: "Remote access uses Tailscale, but the tailscale command isn't installed",
      fix: tailscaleFix,
    };
  try {
    const listener = await remoteListener(
      { ...context.config, listen: plan.listen },
      // The identity is only handed back with the address; doctor discards it unread.
      {
        ...ports.network,
        identity: () => ({ key: Buffer.alloc(0), cert: Buffer.alloc(0), fingerprint: "" }),
      },
    );
    if (!listener) return { status: "ok", message: "local only", fix: accessFix };
    const where = `${urlHost(listener.advertisedHost)}:${listener.port}`;
    return {
      status: "ok",
      message: plan.listen === "lan" ? `LAN at ${where}` : `Tailscale at ${where}`,
      fix: accessFix,
    };
  } catch (error) {
    if (plan.listen === "tailscale")
      return {
        status: "warn",
        message: `Remote access uses Tailscale, but it isn't connected${await tailscaleState(ports)}`,
        fix: tailscaleFix,
      };
    return {
      status: "warn",
      message: error instanceof Error ? error.message.slice(0, 512) : "No LAN address found",
      fix: "Connect this computer to a network, or set ACE_ADVERTISE_HOST to its LAN address.",
    };
  }
}

/** Tailscale's own word for its state (Stopped, NeedsLogin), when it gives one. */
async function tailscaleState(ports: RemoteAccessPorts): Promise<string> {
  try {
    const parsed = BackendState.safeParse(JSON.parse(await ports.network.status()));
    return parsed.success ? ` (${parsed.data.BackendState})` : "";
  } catch {
    return "";
  }
}

/** Whether Tailscale can issue the certificate browsers need for this machine's ts.net name. */
function tailscaleHttpsCheck(ports: RemoteAccessPorts, load: () => Promise<Plan>): Check {
  return {
    id: "remote.tailscale-https",
    fix: httpsFix,
    async run() {
      if ((await load()).listen !== "tailscale")
        return {
          status: "ok",
          message: "Not used: remote access isn't on Tailscale",
          fix: httpsFix,
        };
      let names;
      try {
        names = CertificateNames.safeParse(JSON.parse(await ports.network.status()));
      } catch {
        names = undefined;
      }
      if (!names?.success)
        return { status: "ok", message: "Not checked: Tailscale isn't connected", fix: httpsFix };
      const name = names.data.Self.DNSName.replace(/\.$/, "").toLowerCase();
      const issuable = (names.data.CertDomains ?? []).some(
        (domain) => domain.replace(/\.$/, "").toLowerCase() === name,
      );
      return issuable
        ? { status: "ok", message: `Browsers trust ${name}`, fix: httpsFix }
        : {
            status: "warn",
            message: `Browsers can't pair over Tailscale: HTTPS certificates are off for ${name || "this tailnet"}`,
            fix: httpsFix,
          };
    },
  };
}

function certificateCheck(context: DoctorContext, load: () => Promise<Plan>): Check {
  const folder = join(context.config.dataDir, "tls");
  const renewFix = `Stop ace, move ${tilde(folder, context)} aside and start ace: it makes a new certificate. Paired devices then need pairing again.`;
  return {
    id: "remote.certificate",
    fix: renewFix,
    async run() {
      const plan = await load();
      if (plan.listen === "local")
        return {
          status: "ok",
          message: plan.relayUrl
            ? "Not used: devices connect through the relay"
            : "Not checked: remote access is off",
          fix: renewFix,
        };
      let pem: string;
      try {
        pem = await readFile(join(folder, "cert.pem"), "utf8");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT")
          return {
            status: "ok",
            message: "No certificate yet; ace makes one when remote access starts",
            fix: renewFix,
          };
        return {
          status: "warn",
          message: "The remote access certificate can't be read",
          fix: renewFix,
        };
      }
      return certificateVerdict(pem, context.now(), renewFix);
    },
  };
}

/** Warns from two weeks before the certificate stops working, and once it has. */
export function certificateVerdict(pem: string, now: number, fix: string): Verdict {
  let expires: Date;
  try {
    expires = new X509Certificate(pem).validToDate;
  } catch {
    return {
      status: "warn",
      message: "The remote access certificate isn't a valid certificate",
      fix,
    };
  }
  const date = expires.toISOString().slice(0, 10);
  const left = expires.getTime() - now;
  if (left <= 0)
    return {
      status: "warn",
      message: `The remote access certificate expired on ${date}; devices can't connect`,
      fix,
    };
  if (left < renewWithinMs) {
    const days = Math.max(1, Math.ceil(left / day));
    return {
      status: "warn",
      message: `The remote access certificate expires on ${date}, in ${days} ${days === 1 ? "day" : "days"}`,
      fix,
    };
  }
  return { status: "ok", message: `Certificate valid until ${date}`, fix };
}

function devices(count: number | undefined): string[] {
  if (count === undefined) return [];
  return [`${count} paired ${count === 1 ? "device" : "devices"}`];
}

function relayHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(unreadable address)";
  }
}

function tilde(path: string, context: DoctorContext): string {
  return context.home && path.startsWith(`${context.home}/`)
    ? `~${path.slice(context.home.length)}`
    : path;
}
