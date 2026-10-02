import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign,
  type KeyObject,
} from "node:crypto";
import { WebPushSubscription } from "@ace/protocol";

function hmac(key: Uint8Array, data: Uint8Array): Buffer {
  return createHmac("sha256", key).update(data).digest();
}
function expand(key: Uint8Array, info: Uint8Array, length: number): Buffer {
  return hmac(key, Buffer.concat([info, Buffer.from([1])])).subarray(0, length);
}
/** RFC 8291 single-record encryption. Randomness is supplied by the transport. */
export function encryptWebPush(input: {
  subscription: unknown;
  plaintext: Uint8Array;
  salt: Uint8Array;
  privateKey: Uint8Array;
}): Buffer {
  const subscription = WebPushSubscription.parse(input.subscription);
  if (input.salt.length !== 16 || input.plaintext.length > 3993)
    throw new Error("Invalid Web Push record size");
  const receiver = Buffer.from(subscription.p256dh, "base64url");
  const auth = Buffer.from(subscription.auth, "base64url");
  if (receiver.length !== 65 || receiver[0] !== 4 || auth.length !== 16)
    throw new Error("Invalid Web Push subscription key");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(input.privateKey);
  const sender = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(receiver); // OpenSSL validates the remote point.
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), receiver, sender]);
  const ikm = expand(hmac(auth, secret), info, 32);
  const prk = hmac(input.salt, ikm);
  const key = expand(prk, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = expand(prk, Buffer.from("Content-Encoding: nonce\0"), 12);
  const cipher = createCipheriv("aes-128-gcm", key, nonce);
  const encrypted = Buffer.concat([
    cipher.update(input.plaintext),
    cipher.update(Buffer.from([2])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(21);
  header.set(input.salt);
  header.writeUInt32BE(4096, 16);
  header[20] = sender.length;
  return Buffer.concat([header, sender, encrypted]);
}
export function p256SigningKey(pem: string): KeyObject {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    throw new Error("Expected P-256 signing key");
  return key;
}
export function signJwt(key: KeyObject, header: object, claims: object): string {
  const body = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return `${body}.${sign("sha256", Buffer.from(body), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
export function vapidAuthorization(
  key: KeyObject,
  endpoint: string,
  subject: string,
  now: number,
): string {
  const publicKey = createPublicKey(key).export({ format: "jwk" });
  if (!publicKey.x || !publicKey.y) throw new Error("Invalid VAPID public key");
  const point = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(publicKey.x, "base64url"),
    Buffer.from(publicKey.y, "base64url"),
  ]).toString("base64url");
  const token = signJwt(
    key,
    { typ: "JWT", alg: "ES256" },
    { aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 3600, sub: subject },
  );
  return `vapid t=${token}, k=${point}`;
}
