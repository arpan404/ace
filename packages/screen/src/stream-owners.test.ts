import { expect, it } from "vitest";
import { StreamOwners } from "./stream-owners.ts";

const viewer = {
  codec: "h264",
  maxWidth: 800,
  maxHeight: 600,
  fps: 30,
  bitrate: 2_000_000,
} as const;

it("closing while the helper refuses an update settles, and the refusal reaches only its caller", async () => {
  const refused = Promise.withResolvers<never>();
  const owners = new StreamOwners({ apply: () => refused.promise, idle: () => undefined });
  const update = owners.set("viewer", viewer);
  const closing = owners.close();
  refused.reject(new Error("helper exited"));
  await expect(update).rejects.toThrow("helper exited");
  await expect(closing).resolves.toBeUndefined();
});
