import type { ClientApi } from "@ace/client";
import { SettingsValues } from "@ace/protocol";

/** The home folder remains allowed when someone adds the first additional root. */
export async function addProjectRoot(client: ClientApi, path: string): Promise<void> {
  const [settings, home] = await Promise.all([
    client.request({ type: "settings.get", key: "projects.roots", scope: {} }),
    client.request({ type: "projects.request", operation: { op: "fs.home" } }),
  ]);
  if (!settings.ok || home.result.kind !== "home")
    throw new Error("Couldn't read allowed folders. Reconnect and try again.");
  const configured = SettingsValues.shape["projects.roots"].parse(settings.entries[0]?.value ?? []);
  const roots = configured.length ? configured : home.result.roots;
  await saveProjectRoots(client, [...new Set([...roots, path])]);
}
export async function saveProjectRoots(client: ClientApi, roots: string[]): Promise<void> {
  const value = SettingsValues.shape["projects.roots"].parse(roots);
  const reply = await client.request({
    type: "settings.set",
    key: "projects.roots",
    value,
    layer: { kind: "global" },
  });
  if (!reply.ok)
    throw new Error("Couldn't save allowed folders. Check the folder path and try again.");
}
