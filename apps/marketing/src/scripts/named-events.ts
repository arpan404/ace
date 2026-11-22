import { links } from "../site.ts";

/*
 * Rules for the marketing site's named PostHog events. Pure, so they are tested without a
 * browser; marketing-events.ts applies them to clicks and page events.
 */

/** The event a tab list sends when the visitor chooses a tab; tabs.ts dispatches it. */
export const tabChosenEvent = "ace:tab-chosen";

export interface TabChosen {
  list: string;
  tab: string;
}

export type GithubTarget = "repository" | "issues" | "releases" | "license" | "other";

/** Which part of ace's GitHub repository a link opens, or undefined for any other address. */
export function githubTarget(href: string): GithubTarget | undefined {
  if (href !== links.source && !href.startsWith(`${links.source}/`)) return undefined;
  const section = href.slice(links.source.length + 1).split(/[/?#]/)[0];
  if (!section) return "repository";
  if (section === "issues" || section === "releases") return section;
  if (href === links.license) return "license";
  return "other";
}

/** Spade maker controls, named by the data attribute that marks each one in Maker.astro. */
export type MakerAction = "shuffle" | "part" | "option" | "name" | "task";

/**
 * The maker action a control stands for, from its data attributes. `data-value` marks an option
 * only inside the options row, so the caller passes whether the control sits there.
 */
export function makerAction(data: DOMStringMap, inOptions: boolean): MakerAction | undefined {
  if ("shuffle" in data) return "shuffle";
  if ("partField" in data) return "part";
  if ("name" in data) return "name";
  if ("task" in data) return "task";
  if (inOptions && "value" in data) return "option";
  return undefined;
}
