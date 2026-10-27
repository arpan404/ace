import type { ClientCore } from "@ace/client";
import { z } from "zod";
import { host } from "./host.ts";
import { preview } from "./presentation.ts";
import {
  readSettingsModels,
  readSettingsPage,
  SettingsModelsRequest,
  SettingsModelStar,
  SettingsPageRequest,
  SettingsPageSet,
  starSettingsModel,
  writeSettingsPage,
  type PagePorts,
} from "./settings-page.ts";

/*
 * The native service entry for settings pages (`settings-page.ts`): which requests are its own,
 * and the phone's clock and text bounds as the ports they run on.
 */

const PageRequest = z.discriminatedUnion("type", [
  SettingsPageRequest,
  SettingsPageSet,
  SettingsModelsRequest,
  SettingsModelStar,
]);
export type PageRequest = z.infer<typeof PageRequest>;

export function settingsPageRequest(raw: unknown): PageRequest | undefined {
  return PageRequest.safeParse(raw).data;
}

export function answerSettingsPage(
  owner: ClientCore,
  request: PageRequest,
  signal: AbortSignal,
): Promise<unknown> {
  const ports: PagePorts = { owner, now: () => host.now(), preview, signal };
  switch (request.type) {
    case "settings.page":
      return readSettingsPage(ports, request.page);
    case "settings.page.set":
      return writeSettingsPage(ports, request);
    case "settings.models":
      return readSettingsModels(ports, request);
    case "settings.models.star":
      return starSettingsModel(ports, request.key);
  }
}
