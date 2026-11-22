import { expect, it } from "vitest";
import type { Client } from "./socket-test-support.ts";
import {
  answerTo,
  homeRoot,
  removeRoot,
  startHome,
  enrollHome,
} from "./org-host-daemon-test-support.ts";

// ADR 0209 §3: the host's operator gets no member content on any transport. A support bundle
// with conversations holds every tree's recent events, so an org host makes none and serves
// none made before it was enrolled; a bundle without them is the operator's to triage with.

async function exportBundle(client: Client, includeThreads: boolean) {
  client.send({
    type: "files.request",
    requestId: `export-${includeThreads}`,
    scope: "support",
    operation: { op: "artifact.support", includeThreads },
  });
  return answerTo(client, `export-${includeThreads}`);
}

async function download(client: Client, artifactId: string) {
  client.send({
    type: "files.request",
    requestId: `download-${artifactId}`,
    scope: "support",
    operation: { op: "artifact.download", artifactId, offset: 0 },
  });
  return answerTo(client, `download-${artifactId}`);
}

const artifactOf = (message: unknown): string => {
  const value = Reflect.get(Object(message), "value");
  const id = Reflect.get(Object(value), "artifactId");
  if (typeof id !== "string") throw new Error(JSON.stringify(message));
  return id;
};

it("an org host exports no conversations, not even a bundle made before it was enrolled", async () => {
  const root = await homeRoot();
  try {
    // While the machine was a person's, they exported a bundle with their conversations.
    const personal = await startHome(root);
    const before = artifactOf(await exportBundle(await personal.hostSocket(), true));
    await personal.close();

    // Enrolled: the same token is now the host's operator.
    await enrollHome(root);
    const org = await startHome(root);
    const host = await org.hostSocket();
    expect(await exportBundle(host, true)).toMatchObject({ type: "error", code: "forbidden" });
    expect(await download(host, before)).toMatchObject({ type: "error", code: "forbidden" });
    // A bundle without conversations still serves the operator, and downloads.
    const plain = artifactOf(await exportBundle(host, false));
    expect(await download(host, plain)).toMatchObject({ type: "files.ready" });
    await org.close();
  } finally {
    await removeRoot(root);
  }
});
