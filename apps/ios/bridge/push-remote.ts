import type { ClientCore } from "@ace/client";
import { SourceControlPreferences } from "@ace/protocol";
import { WorkspaceRefusal } from "./changes.ts";

/**
 * The remote every push from the phone names: the global source control remote name, as the
 * web's `readPushRemote` and the person's own Git would. The push before a new pull request
 * names it too; the daemon pushes that one to the PR's head (ADR 0120).
 */
export async function globalRemote(owner: Pick<ClientCore, "request">): Promise<string> {
  const response = await owner.request({
    type: "settings.get",
    key: "sourceControl.preferences",
    scope: {},
  });
  const entry = response.entries.find((item) => item.key === "sourceControl.preferences");
  if (!response.ok || !entry) throw new WorkspaceRefusal("forge_preferences_changed");
  return SourceControlPreferences.parse(entry.value).remote;
}
