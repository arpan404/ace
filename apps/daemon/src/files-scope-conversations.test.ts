import { expect, it } from "vitest";
import type { FilesService } from "@ace/files";
import { filesScope } from "./files-scope.ts";

// ADR 0209 §3: a conversation bundle is member content. A download opened while the machine was a
// person's stops at its next chunk once it is an organization's host.

it("a conversation bundle's channel stops serving the moment its home becomes an org host", async () => {
  let orgHost = false;
  const resolve = filesScope({
    authorize: () => true,
    threadAccess: () => true,
    connected: () => true,
    conversations: () => !orgHost,
    options: { supportFiles: {} as FilesService },
  });
  const download = (artifactId: string) =>
    resolve(undefined, "support", { op: "artifact.download", artifactId, offset: 0 }, undefined);
  const conversations = await download("local-support-1");
  const plain = await download("support-1");
  expect(conversations.allowed("read")).toBe(true);
  orgHost = true;
  expect(conversations.allowed("read")).toBe(false);
  // A bundle without conversations keeps serving the operator.
  expect(plain.allowed("read")).toBe(true);
});
