import {
  createServer,
  connect,
  type ServerHttp2Stream,
  type IncomingHttpHeaders,
} from "node:http2";
import { generateKeyPairSync, verify } from "node:crypto";
import { once } from "node:events";
import { z } from "zod";
import { Notification, NotificationDevice } from "@ace/protocol";
import { expect, it } from "vitest";
import { createApnsTransport } from "./index.ts";

it("sends APNs alert and deep link over HTTP2 with a verifiable ES256 provider token", async () => {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  let time = Date.parse("2026-10-02T00:00:00Z");
  const requests: { headers: IncomingHttpHeaders; body: Buffer }[] = [];
  let code = 200;
  const server = createServer();
  server.on("stream", (stream: ServerHttp2Stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      requests.push({ headers, body: Buffer.concat(chunks) });
      stream.respond({ ":status": code });
      stream.end(code === 200 ? "" : '{"reason":"test"}');
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  const transport = createApnsTransport(
    {
      teamId: "TEAM123456",
      keyId: "KEY1234567",
      topic: "dev.ace.app",
      privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    },
    () => time,
    () => connect(`http://127.0.0.1:${address.port}`),
  );
  const device = NotificationDevice.parse({
    id: "phone",
    preferences: {},
    address: { channel: "apns", platform: "phone", token: "ab".repeat(32) },
  });
  const notification = Notification.parse({
    id: "n:10",
    threadId: "thread",
    title: "Safe title",
    status: "needs_you",
    interactionId: "approval",
    backgroundCount: 0,
    actions: [{ action: "approve", optionId: "yes" }],
  });
  try {
    expect(await transport.send(device, notification, new AbortController().signal)).toBe(
      "accepted",
    );
    const received = requests[0];
    if (!received) throw new Error("No request");
    expect(received.headers).toMatchObject({
      ":method": "POST",
      ":path": `/3/device/${"ab".repeat(32)}`,
      "apns-topic": "dev.ace.app",
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(time / 1000 + 86400),
    });
    expect(String(received.headers["apns-collapse-id"])).toHaveLength(64);
    const payload = z
      .object({
        aps: z.object({
          alert: z.object({ title: z.string(), body: z.string() }),
          category: z.string(),
          sound: z.string(),
        }),
        ace: Notification,
      })
      .parse(JSON.parse(received.body.toString()));
    expect(payload).toEqual({
      aps: {
        alert: { title: "Safe title", body: "needs_you" },
        category: "ACE_APPROVAL",
        sound: "default",
      },
      ace: notification,
    });
    const [header, claims, signature] = String(received.headers.authorization)
      .replace(/^bearer /, "")
      .split(".");
    if (!header || !claims || !signature) throw new Error("Invalid token");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "KEY1234567",
    });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({
      iss: "TEAM123456",
      iat: time / 1000,
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${claims}`),
        { key: keys.publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
    for (const [status, expected] of [
      [410, "gone"],
      [429, "retry"],
      [503, "retry"],
      [403, "failed"],
    ] as const) {
      code = status;
      expect(await transport.send(device, notification, new AbortController().signal)).toBe(
        expected,
      );
    }
    expect(requests).toHaveLength(5);
    expect(requests[1]?.headers.authorization).toBe(received.headers.authorization);
    code = 200;
    await transport.send(
      device,
      { ...notification, threadId: Notification.shape.threadId.parse("other") },
      new AbortController().signal,
    );
    expect(requests[5]?.headers["apns-collapse-id"]).not.toBe(received.headers["apns-collapse-id"]);
    time += 49 * 60_000;
    await transport.send(device, notification, new AbortController().signal);
    expect(requests[6]?.headers.authorization).toBe(received.headers.authorization);
    expect(requests[6]?.headers["apns-collapse-id"]).toBe(received.headers["apns-collapse-id"]);
    time += 60_000;
    await transport.send(device, notification, new AbortController().signal);
    const refreshed = String(requests[7]?.headers.authorization).replace(/^bearer /, "");
    expect(refreshed).not.toBe(String(received.headers.authorization).replace(/^bearer /, ""));
    const [newHeader, newClaims, newSignature] = refreshed.split(".");
    if (!newHeader || !newClaims || !newSignature) throw new Error("Missing rotated token");
    expect(JSON.parse(Buffer.from(newClaims, "base64url").toString())).toEqual({
      iss: "TEAM123456",
      iat: time / 1000,
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${newHeader}.${newClaims}`),
        { key: keys.publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(newSignature, "base64url"),
      ),
    ).toBe(true);
  } finally {
    transport.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it("aborted APNs sends never reach the peer", async () => {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const transport = createApnsTransport(
    {
      teamId: "TEAM123456",
      keyId: "KEY1234567",
      topic: "dev.ace.app",
      privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    },
    () => 0,
    () => {
      throw new Error("Must not connect");
    },
  );
  const controller = new AbortController();
  controller.abort();
  expect(
    await transport.send(
      NotificationDevice.parse({
        id: "p",
        preferences: {},
        address: { channel: "apns", platform: "phone", token: "ab".repeat(32) },
      }),
      Notification.parse({
        id: "n:1",
        threadId: "t",
        title: "",
        status: "done",
        backgroundCount: 0,
        actions: [],
      }),
      controller.signal,
    ),
  ).toBe("retry");
  transport.close();
});
