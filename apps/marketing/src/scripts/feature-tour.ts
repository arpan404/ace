import type { Feature } from "../content/features.ts";
import type { CastId } from "./feature-camera.ts";
import type { StepPlan } from "./feature-steps.ts";

/*
 * What a feature story (components/features/FeatureStory.astro) tells, built at page build: a
 * feature page's own sections, or the features page's tour of every feature, one step each.
 * Either way the story is its steps, the plan the drawing follows, the hardware it stands and
 * the lines between that hardware.
 */

export interface StoryStep {
  /** The step's anchor, so an index can jump to it. */
  id?: string;
  title: string;
  body: string;
  link?: { href: string; label: string; name: string };
}

export interface Story {
  label: string;
  steps: StoryStep[];
  plan: StepPlan[];
  cast: CastId[];
  links: Feature["links"];
}

/** A feature page's story: its sections, in order, on its own hardware. */
export function featureStory(feature: Feature): Story {
  return {
    label: `${feature.name}, step by step`,
    steps: feature.sections.map((section) => ({
      title: section.heading,
      body: section.body.join(" "),
    })),
    plan: feature.sections.map((section) => section.show),
    cast: feature.cast,
    links: feature.links,
  };
}

/** The first sentence of a paragraph: up to the first full stop that ends a sentence. */
export function firstSentence(text: string): string {
  const end = /[.!?](?=\s+[A-Z]|$)/.exec(text.trim());
  return end ? text.trim().slice(0, end.index + 1) : text.trim();
}

const castOrder: readonly CastId[] = ["mac", "build", "workstation", "phone"];

/**
 * The features page's tour: each feature as one step (its name, the first sentence of its
 * intro, a link to its page) playing its preview scene, on all the hardware any of them needs.
 * A line to a machine carries the verb of the first feature that draws it.
 */
export function tourStory(features: readonly Feature[], label: string): Story {
  const cast = castOrder.filter(
    (id) => id === "mac" || features.some((feature) => feature.cast.includes(id)),
  );
  const links: Feature["links"] = [];
  for (const line of features.flatMap((feature) => feature.links)) {
    if (!links.some((entry) => entry.to === line.to)) links.push(line);
  }
  return {
    label,
    steps: features.map((feature) => ({
      id: feature.slug,
      title: feature.name,
      body: firstSentence(feature.intro),
      link: { href: `/features/${feature.slug}/`, label: "How it works", name: feature.name },
    })),
    plan: features.map((feature) => feature.preview),
    cast,
    links,
  };
}
