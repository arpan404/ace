import { expect, it } from "vitest";
import { appIdentities } from "./app-identity.ts";

it("looks up arbitrary installed bundle IDs and keeps the system's localized display name", async () => {
  const read = appIdentities({
    application: async (bundleId) =>
      bundleId === "dev.example.writer"
        ? { path: "/test/Writer.app", displayName: "Localized Writer" }
        : null,
    icon: async () => ({ isEmpty: () => false, toDataURL: () => "data:image/png;base64,AA==" }),
  });
  await expect(read("dev.example.writer")).resolves.toEqual({
    bundleId: "dev.example.writer",
    displayName: "Localized Writer",
    icon: "data:image/png;base64,AA==",
  });
  await expect(read("dev.example.missing")).resolves.toBeNull();
});
it("retains the app name when its icon is oversized or malformed", async () => {
  let url = "data:image/png;base64," + "A".repeat(128 * 1024);
  const read = appIdentities({
    application: async () => ({ path: "/test/Writer.app", displayName: "Writer" }),
    icon: async () => ({ isEmpty: () => false, toDataURL: () => url }),
  });
  await expect(read("dev.example.writer")).resolves.toMatchObject({
    displayName: "Writer",
    icon: null,
  });
  url = "file:///private/path";
  await expect(read("dev.example.another")).resolves.toMatchObject({
    displayName: "Writer",
    icon: null,
  });
});
it("evicts old app identities after the cache reaches its bound", async () => {
  let name = "Before";
  const read = appIdentities({
    application: async () => ({ path: "/test/Writer.app", displayName: name }),
    icon: async () => ({ isEmpty: () => true, toDataURL: () => "" }),
  });
  await read("dev.example.writer");
  name = "After";
  await expect(read("dev.example.writer")).resolves.toMatchObject({ displayName: "Before" });
  for (let index = 0; index < 256; index++) await read(`dev.example.app${index}`);
  await expect(read("dev.example.writer")).resolves.toMatchObject({ displayName: "After" });
});
