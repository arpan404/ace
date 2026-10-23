import { X509Certificate, createPrivateKey } from "node:crypto";
import { createSecureContext, type SecureContext } from "node:tls";

export interface TailscalePem {
  /** Leaf first, then the issuing chain. */
  cert: string;
  key: string;
  /** When the leaf stops being valid, in epoch milliseconds. */
  expires: number;
}

const pemBlock = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]+?-----END \1-----/g;

/**
 * Splits `tailscale cert` output into the certificate chain and its private key. Undefined unless
 * the leaf names `name`, is valid at `now` and matches the key, so a bad issuance never replaces a
 * working certificate.
 */
export function parseTailscaleCertificate(
  output: string,
  name: string,
  now: number,
): TailscalePem | undefined {
  const chain: string[] = [];
  let key: string | undefined;
  for (const [block, label = ""] of output.matchAll(pemBlock)) {
    if (label === "CERTIFICATE") chain.push(block);
    else if (label.endsWith("PRIVATE KEY")) key ??= block;
  }
  const [leaf] = chain;
  if (!leaf || !key) return undefined;
  let expires: number;
  try {
    const certificate = new X509Certificate(leaf);
    if (certificate.checkHost(name) === undefined) return undefined;
    if (now < certificate.validFromDate.getTime() || now >= certificate.validToDate.getTime())
      return undefined;
    if (!certificate.checkPrivateKey(createPrivateKey(key))) return undefined;
    expires = certificate.validToDate.getTime();
  } catch {
    return undefined;
  }
  return { cert: `${chain.join("\n")}\n`, key: `${key}\n`, expires };
}

export interface TrustedCertificateOptions {
  /** The machine's ts.net name, as Tailscale lists it in its certificate domains. */
  name: string;
  fetch(name: string): Promise<string>;
  now(): number;
  delay(callback: () => void, milliseconds: number): () => void;
  log?(error: Error): void;
}

export interface TrustedCertificate {
  /** The ts.net name this certificate is for. */
  readonly name: string;
  /** For SNI: the Tailscale certificate when a client asks for its ts.net name, else nothing. */
  select(servername: string): SecureContext | undefined;
  /** True while a valid Tailscale certificate is served, so a ts.net link works in browsers. */
  active(): boolean;
  /** Settles after the first fetch, whether or not it produced a certificate. */
  ready: Promise<void>;
  stop(): void;
}

const refreshMs = 12 * 60 * 60 * 1000;
const retryMs = 10 * 60 * 1000;

/**
 * Keeps the browser-trusted certificate Tailscale issues for this machine's ts.net name, fetched
 * now and refreshed twice a day (Tailscale renews it before expiry). Until one is fetched, or if
 * the tailnet can't issue one, clients get ace's own pinned certificate instead.
 */
export function trustedCertificate(options: TrustedCertificateOptions): TrustedCertificate {
  let context: SecureContext | undefined;
  let expires = 0;
  let current = "";
  let stopped = false;
  let failing = false;
  let cancel: (() => void) | undefined;
  const schedule = (milliseconds: number) => {
    if (stopped) return;
    cancel = options.delay(() => {
      cancel = undefined;
      void refresh();
    }, milliseconds);
  };
  const refresh = async () => {
    try {
      const pem = parseTailscaleCertificate(
        await options.fetch(options.name),
        options.name,
        options.now(),
      );
      if (!pem) throw new Error("Tailscale returned no usable certificate");
      if (stopped) return;
      if (pem.cert !== current) {
        context = createSecureContext({ cert: pem.cert, key: pem.key, minVersion: "TLSv1.2" });
        expires = pem.expires;
        current = pem.cert;
      }
      failing = false;
      schedule(refreshMs);
    } catch (error) {
      if (stopped) return;
      if (!failing) options.log?.(certificateError(options.name, error));
      failing = true;
      schedule(retryMs);
    }
  };
  const ready = refresh();
  // A certificate that expired while refreshes kept failing is no use to anyone.
  const active = () => context !== undefined && options.now() < expires;
  return {
    name: options.name,
    select: (servername) =>
      active() && servername.toLowerCase().replace(/\.$/, "") === options.name
        ? context
        : undefined,
    active,
    ready,
    stop() {
      stopped = true;
      cancel?.();
      cancel = undefined;
    },
  };
}

function certificateError(name: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : "";
  // Linux tailscaled lets only root or its operator fetch certificates.
  const fix = /access denied|permission/i.test(detail)
    ? "Run `sudo tailscale set --operator=$USER` so ace can fetch it."
    : "Turn on HTTPS Certificates on the DNS page of the Tailscale admin console; ace keeps trying.";
  return new Error(
    `Browsers won't trust ${name} until Tailscale issues its HTTPS certificate. ${fix}`,
    { cause },
  );
}
