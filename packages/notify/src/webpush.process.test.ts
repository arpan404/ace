import {
  createDecipheriv,
  createECDH,
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  verify,
} from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { z } from "zod";
import { Notification, NotificationDevice } from "@ace/protocol";
import { expect, it } from "vitest";
import { encryptWebPush, createWebPushTransport } from "./index.ts";

const signing = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = signing.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const notice = Notification.parse({
  id: "n:7",
  threadId: "thread",
  title: "Build",
  status: "done",
  backgroundCount: 0,
  actions: [],
});

it("matches the complete RFC 8291 section 5 ciphertext test vector", () => {
  // Primary standard example, independently fixed expected bytes.
  const encrypted = encryptWebPush({
    subscription: {
      endpoint: "https://push.example.net/push",
      auth: "BTBZMqHH6r4Tts7J_aSIgg",
      p256dh:
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    },
    plaintext: Buffer.from("When I grow up, I want to be a watermelon"),
    salt: Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url"),
    privateKey: Buffer.from("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "base64url"),
  });
  expect(encrypted.toString("base64url")).toBe(
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  );
});
const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();
function decrypt(body: Buffer, receiver: ReturnType<typeof createECDH>, auth: Buffer): Buffer {
  const sender = body.subarray(21, 86);
  const secret = receiver.computeSecret(sender);
  const ikm = hmac(
    hmac(auth, secret),
    Buffer.concat([
      Buffer.from("WebPush: info\0"),
      receiver.getPublicKey(),
      sender,
      Buffer.from([1]),
    ]),
  );
  const prk = hmac(body.subarray(0, 16), ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const cipher = createDecipheriv("aes-128-gcm", cek, nonce);
  cipher.setAuthTag(body.subarray(-16));
  const plaintext = Buffer.concat([cipher.update(body.subarray(86, -16)), cipher.final()]);
  expect(plaintext.at(-1)).toBe(2);
  return plaintext.subarray(0, -1);
}
it("sends an encrypted POST with valid origin-scoped VAPID and TTL over HTTP", async () => {
  const receiver = createECDH("prime256v1");
  receiver.generateKeys();
  const auth = Buffer.alloc(16, 9);
  const requests: { headers: import("node:http").IncomingHttpHeaders; body: Buffer }[] = [];
  let status = 201;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ headers: request.headers, body: Buffer.concat(chunks) });
    response.writeHead(status);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  const time = Date.parse("2026-10-02T00:00:00Z");
  // Transport endpoint remains HTTPS allowlisted; only the network boundary is redirected to the local test peer.
  const request: typeof fetch = (url, init) =>
    fetch(`http://127.0.0.1:${address.port}${new URL(String(url)).pathname}`, init);
  const transport = createWebPushTransport(
    {
      privateKey: pem,
      subject: "mailto:ace@example.com",
      allowedOrigins: ["https://push.example.com"],
    },
    () => time,
    request,
  );
  const device = NotificationDevice.parse({
    id: "web",
    preferences: {},
    address: {
      channel: "webpush",
      platform: "web",
      subscription: {
        endpoint: "https://push.example.com/sub",
        p256dh: receiver.getPublicKey().toString("base64url"),
        auth: auth.toString("base64url"),
      },
    },
  });
  try {
    expect(await transport.send(device, notice, new AbortController().signal)).toBe("accepted");
    const received = requests[0];
    if (!received) throw new Error("No request");
    expect(received.headers).toMatchObject({
      "content-encoding": "aes128gcm",
      ttl: "86400",
      "content-type": "application/octet-stream",
    });
    expect(
      Notification.parse(JSON.parse(decrypt(received.body, receiver, auth).toString())),
    ).toEqual(notice);
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(String(received.headers.authorization));
    if (!match?.[1] || !match[2]) throw new Error("Invalid VAPID");
    const [header, claims, signature] = match[1].split(".");
    if (!header || !claims || !signature) throw new Error("Invalid JWT");
    expect(
      z
        .object({ aud: z.string(), exp: z.number(), sub: z.string() })
        .parse(JSON.parse(Buffer.from(claims, "base64url").toString())),
    ).toEqual({
      aud: "https://push.example.com",
      exp: time / 1000 + 3600,
      sub: "mailto:ace@example.com",
    });
    const point = Buffer.from(match[2], "base64url");
    const publicKey = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: point.subarray(1, 33).toString("base64url"),
        y: point.subarray(33).toString("base64url"),
      },
      format: "jwk",
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${claims}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
    for (const [code, expected] of [
      [410, "gone"],
      [429, "retry"],
      [503, "retry"],
      [400, "failed"],
    ] as const) {
      status = code;
      expect(await transport.send(device, notice, new AbortController().signal)).toBe(expected);
    }
    const untrusted = NotificationDevice.parse({
      ...device,
      address: {
        ...device.address,
        subscription: {
          endpoint: "https://localhost/private",
          p256dh: receiver.getPublicKey().toString("base64url"),
          auth: auth.toString("base64url"),
        },
      },
    });
    expect(await transport.send(untrusted, notice, new AbortController().signal)).toBe("failed");
    expect(requests).toHaveLength(5);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it("rejects oversized plaintext, malformed subscription points and non-P256 VAPID keys", () => {
  const subscription = {
    endpoint: "https://push.example.net/p",
    p256dh: Buffer.alloc(65, 4).toString("base64url"),
    auth: Buffer.alloc(16).toString("base64url"),
  };
  expect(() =>
    encryptWebPush({
      subscription,
      plaintext: Buffer.alloc(3994),
      salt: Buffer.alloc(16),
      privateKey: Buffer.alloc(32, 1),
    }),
  ).toThrow("size");
  expect(() =>
    encryptWebPush({
      subscription,
      plaintext: Buffer.alloc(1),
      salt: Buffer.alloc(16),
      privateKey: Buffer.alloc(32, 1),
    }),
  ).toThrow();
  const wrong = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
  expect(() =>
    createWebPushTransport(
      {
        privateKey: wrong.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
        subject: "mailto:a@b.c",
        allowedOrigins: ["https://push.example.net"],
      },
      () => 0,
    ),
  ).toThrow("P-256");
});
