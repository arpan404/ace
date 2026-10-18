import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { elidedDigest } from "@ace/provider-kit/binary-elision";
import { harness, subtype } from "./session.test-helper.ts";
import { object } from "./native.ts";

function screenshot(bytes: number, seed: number): Buffer {
  const image = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) image[i] = (i * seed + (i >> 10)) % 256;
  return image;
}
function digests(value: unknown): string[] {
  if (typeof value === "string") return elidedDigest(value) ? [elidedDigest(value) ?? ""] : [];
  if (Array.isArray(value)) return value.flatMap(digests);
  if (value && typeof value === "object") return Object.values(value).flatMap(digests);
  return [];
}

test("a message with multi-megabyte screenshots is delivered, run and confirmed without ending the session", async () => {
  const first = screenshot(2 * 1024 * 1024, 31);
  const second = screenshot(3 * 1024 * 1024, 17);
  const identities: { commandId: string; nativeId: string }[] = [];
  const h = await harness(
    undefined,
    "root",
    {},
    { onInputMessage: (identity) => identities.push(identity) },
  );
  try {
    await expect(
      h.session.send(
        [
          { type: "text", text: "why does this layout overflow?" },
          {
            type: "image",
            mimeType: "image/png",
            url: `data:image/png;base64,${first.toString("base64")}`,
          },
          {
            type: "image",
            mimeType: "image/png",
            url: `data:image/png;base64,${second.toString("base64")}`,
          },
        ],
        "queue",
        "screenshots",
      ),
    ).resolves.toBeUndefined();
    expect(identities).toHaveLength(1);
    // The fake CLI echoes exactly what it read, and then finishes the turn.
    const echo = await h.wait(subtype("fake_input"));
    await h.wait((frame) => object(frame.data)["type"] === "result");
    expect(digests(echo.data)).toEqual([
      createHash("sha256").update(first).digest("hex"),
      createHash("sha256").update(second).digest("hex"),
    ]);
    expect(h.exits).toEqual([]);
    for (const frame of h.frames) expect(frame.payload?.bytes ?? 0).toBeLessThan(64 * 1024);
  } finally {
    await h.session.close("user");
  }
});
