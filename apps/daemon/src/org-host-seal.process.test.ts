import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createDevThread } from "./commands.ts";
import {
  answerTo,
  homeRoot,
  removeRoot,
  startHome,
  testOrg,
} from "./org-host-daemon-test-support.ts";

// ADR 0209 amendment 1: releasing an org host clears its owner, never its data, and the data stays
// sealed behind the organization's access policy. Personal use starts on a fresh home.

it("a released organization's home keeps its threads behind the org's policy", async () => {
  const root = await homeRoot();
  try {
    // The home the organization used; a release leaves no owner and the organization's seal.
    await (await startHome(root)).close();
    await writeFile(
      join(root, "ace-org-seal.json"),
      JSON.stringify({ kind: "org-seal", org: testOrg }),
    );
    const home = await startHome(root);
    const workspace = home.daemon.store.createWorkspace(join(root, "repo"), "Repo");
    const thread = createDevThread(home.daemon.store, workspace);
    const host = await home.hostSocket();
    host.send({
      type: "items.page",
      requestId: "read",
      threadId: thread.id,
      before: 1,
      limit: 10,
    });
    expect(await answerTo(host, "read")).toMatchObject({ type: "error", code: "forbidden" });
    host.send({
      type: "files.request",
      requestId: "export",
      scope: "support",
      operation: { op: "artifact.support", includeThreads: true },
    });
    expect(await answerTo(host, "export")).toMatchObject({ type: "error", code: "forbidden" });
    await home.close();
  } finally {
    await removeRoot(root);
  }
});
