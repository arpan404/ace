import { generateKeyPairSync, randomBytes, sign } from "node:crypto";

/**
 * A self-signed X.509 v3 certificate (RFC 5280) and its RSA key, as PEM, built with node:crypto
 * alone. Windows ships no OpenSSL, so ace's pinned TLS identity is made here there. Clients pin
 * the public key, so the certificate carries only what TLS needs: no extensions.
 */
export function selfSignedCertificate(input: { commonName: string; days: number; now: Date }): {
  key: string;
  cert: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const serial = randomBytes(16);
  // A positive serial with no leading zero byte, as RFC 5280 asks.
  serial[0] = ((serial[0] ?? 0) & 0x7f) | 0x40;
  const subject = name(input.commonName);
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    sha256WithRsa,
    subject,
    der(0x30, time(input.now), time(new Date(input.now.getTime() + input.days * 86_400_000))),
    subject,
    publicKey.export({ type: "spki", format: "der" }),
  );
  const signature = sign("sha256", tbs, privateKey);
  const certificate = der(0x30, tbs, sha256WithRsa, der(0x03, Buffer.from([0]), signature));
  const lines = certificate.toString("base64").match(/.{1,64}/g) ?? [];
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    cert: `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`,
  };
}

/** One DER element: tag, definite length, then the concatenated contents. */
function der(tag: number, ...contents: Buffer[]): Buffer {
  const body = Buffer.concat(contents);
  let length: number[] = [body.length];
  if (body.length >= 0x80) {
    length = [];
    for (let rest = body.length; rest > 0; rest = Math.floor(rest / 256))
      length.unshift(rest % 256);
    length.unshift(0x80 | length.length);
  }
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
}

function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const base128 = [arc % 128];
    for (let high = Math.floor(arc / 128); high > 0; high = Math.floor(high / 128))
      base128.unshift((high % 128) | 0x80);
    bytes.push(...base128);
  }
  return der(0x06, Buffer.from(bytes));
}

const sha256WithRsa = der(0x30, oid("1.2.840.113549.1.1.11"), der(0x05));

/** `CN=<commonName>` as a UTF8String. */
function name(commonName: string): Buffer {
  return der(0x30, der(0x31, der(0x30, oid("2.5.4.3"), der(0x0c, Buffer.from(commonName)))));
}

/** UTCTime through 2049, GeneralizedTime after, both to the second in UTC. */
function time(date: Date): Buffer {
  const digits = date.toISOString().slice(0, 19).replace(/[-:T]/g, "");
  return date.getUTCFullYear() < 2050
    ? der(0x17, Buffer.from(`${digits.slice(2)}Z`))
    : der(0x18, Buffer.from(`${digits}Z`));
}
