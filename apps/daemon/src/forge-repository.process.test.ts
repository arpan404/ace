import { expect, test } from "vitest";
import { Command } from "@ace/protocol";
import { forgeIdentityFixture } from "./forge-identity-test-support.ts";

test("thread details publish the selected Enterprise remote and its PR creation succeeds", async () => {
  const f = await forgeIdentityFixture();
  try {
    const details = await f.runtime.details(f.thread.id);
    expect(details.repository).toEqual({ forge: "github", host: "git.example.com", owner: "octo", name: "ace" });
    expect(f.store.getThread(f.thread.id)?.details?.repository).toEqual(details.repository);
    expect(await f.runtime.execute(Command.parse({
      id: "create", deviceId: "device", payload: {
        type: "forge.pr.create", threadId: f.thread.id, repository: details.repository,
        input: { branch: "topic", base: "main", title: "Selected repository", summary: "Changes", draft: false, template: { title: "{{title}}", body: "{{summary}}" } },
      },
    }))).toMatchObject({ ok: true, pr: { repository: details.repository, number: 7 } });
    await f.settings.set("sourceControl.preferences", { ...f.preferences, remote: "missing" }, { kind: "global" });
    expect((await f.runtime.details(f.thread.id)).repository).toBeUndefined();
    expect(f.store.getThread(f.thread.id)?.details?.repository).toBeUndefined();
  } finally { await f.close(); }
});
