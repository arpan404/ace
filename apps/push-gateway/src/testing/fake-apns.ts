import { createServer, type IncomingHttpHeaders, type ServerHttp2Stream } from "node:http2";
import {
  createDecipheriv,
  createECDH,
  createHmac,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { once } from "node:events";

export interface ApnsCall {
  headers: IncomingHttpHeaders;
  body: Buffer;
}
/** A local HTTP/2 (h2c) stand-in for APNs. `answer` picks each reply by device token. */
export async function startFakeApns() {
  const calls: ApnsCall[] = [];
  const answers = new Map<string, { status: number; reason?: string }>();
  const server = createServer();
  server.on("stream", (stream: ServerHttp2Stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      calls.push({ headers, body: Buffer.concat(chunks) });
      const token = String(headers[":path"]).split("/").at(-1) ?? "";
      const answer = answers.get(token) ?? { status: 200 };
      stream.respond({ ":status": answer.status, "apns-id": "fake" });
      stream.end(answer.reason ? JSON.stringify({ reason: answer.reason }) : "");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fake APNs port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    calls,
    answer(token: string, status: number, reason?: string) {
      answers.set(token, reason ? { status, reason } : { status });
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
export function signingKeyPem(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}
export function apnsKeyPair() {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    pem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: keys.publicKey,
  };
}
const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();
const expand = (key: Buffer, info: Buffer, length: number) =>
  hmac(key, Buffer.concat([info, Buffer.from([1])])).subarray(0, length);
/** The phone's side of RFC 8291: a receiving key pair and auth secret, and decryption. */
export function phoneKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: auth.toString("base64url"),
    decrypt(record: Buffer): Buffer {
      const salt = record.subarray(0, 16);
      const idLength = record[20] ?? 0;
      const sender = record.subarray(21, 21 + idLength);
      const cipherText = record.subarray(21 + idLength);
      const receiver = ecdh.getPublicKey();
      const secret = ecdh.computeSecret(sender);
      const info = Buffer.concat([Buffer.from("WebPush: info\0"), receiver, sender]);
      const ikm = expand(hmac(auth, secret), info, 32);
      const prk = hmac(salt, ikm);
      const key = expand(prk, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
      const nonce = expand(prk, Buffer.from("Content-Encoding: nonce\0"), 12);
      const decipher = createDecipheriv("aes-128-gcm", key, nonce);
      decipher.setAuthTag(cipherText.subarray(cipherText.length - 16));
      const plain = Buffer.concat([
        decipher.update(cipherText.subarray(0, cipherText.length - 16)),
        decipher.final(),
      ]);
      const end = plain.lastIndexOf(2);
      return plain.subarray(0, end);
    },
  };
}
