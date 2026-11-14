import { agentSettingTitles } from "@ace/ui-core";
import { z } from "zod";
import { settingsPages, type RowSpec } from "./settings-page-rows.ts";

/*
 * Every machine setting the phone shows, as one flat list for Settings' search: which page and
 * section it sits in, its row id (the anchor the page scrolls to) and its title, read from the
 * same page specs the pages draw, so a result and the row it opens can't drift apart. Pure.
 */

export const SettingsIndexRequest = z.object({ type: z.literal("settings.index") });

export interface SettingsIndexEntry {
  page: string;
  pageTitle: string;
  section: string | null;
  row: string;
  title: string;
}

function rowOf(spec: RowSpec): { row: string; title: string } {
  switch (spec.kind) {
    case "static":
      return { row: spec.key, title: spec.title };
    case "defaultProvider":
      return { row: "providers.default", title: agentSettingTitles["providers.default"] };
    case "role":
      return { row: `roles.${spec.role}`, title: agentSettingTitles[`roles.${spec.role}`] };
    case "utilityModel":
      return { row: "generation.model", title: agentSettingTitles["generation.model"] };
  }
}

export function settingsIndex(): { entries: SettingsIndexEntry[] } {
  return {
    entries: Object.values(settingsPages).flatMap((page) =>
      page.sections.flatMap((section) =>
        section.rows.map((spec) => ({
          page: page.id,
          pageTitle: page.title,
          section: section.title,
          ...rowOf(spec),
        })),
      ),
    ),
  };
}
