import { describe, expect, it } from "vitest";
import type { Feature } from "../content/features.ts";
import { featureStory, firstSentence, tourStory } from "./feature-tour.ts";

function feature(slug: Feature["slug"], extra: Partial<Feature> = {}): Feature {
  return {
    slug,
    name: `Name of ${slug}`,
    title: "",
    description: "",
    headline: "",
    intro: `What ${slug} does. More about it.`,
    points: [],
    cast: ["mac"],
    links: [],
    preview: { move: "rest", focus: ["window"] },
    sections: [
      { heading: "First", body: ["One.", "Two."], show: { move: "review", focus: ["changes"] } },
      { heading: "Second", body: ["Three."], show: { move: "keep", focus: ["diff"] } },
    ],
    tools: [],
    questions: [],
    keywords: [],
    ...extra,
  };
}

describe("a feature story", () => {
  it("a feature page tells its own sections, in order", () => {
    const story = featureStory(feature("review"));
    expect(story.steps.map((step) => step.title)).toEqual(["First", "Second"]);
    expect(story.steps[0]?.body).toBe("One. Two.");
    expect(story.plan.map((step) => step.move)).toEqual(["review", "keep"]);
  });

  it("the tour gives each feature one step that links to its page and plays its preview", () => {
    const story = tourStory(
      [
        feature("fleet", { preview: { move: "fleet", focus: ["threads"] } }),
        feature("browser", { preview: { move: "browser", focus: ["window"] } }),
      ],
      "All features",
    );
    expect(story.steps).toEqual([
      {
        id: "fleet",
        title: "Name of fleet",
        body: "What fleet does.",
        link: { href: "/features/fleet/", label: "How it works", name: "Name of fleet" },
      },
      expect.objectContaining({ id: "browser", body: "What browser does." }),
    ]);
    expect(story.plan).toEqual([
      { move: "fleet", focus: ["threads"] },
      { move: "browser", focus: ["window"] },
    ]);
  });

  it("the tour stands every piece of hardware any feature needs, Mac first, each line once", () => {
    const story = tourStory(
      [
        feature("mobile", { cast: ["mac", "phone"], links: [{ to: "phone", verb: "asks you" }] }),
        feature("fleet", {
          cast: ["mac", "build", "phone"],
          links: [
            { to: "build", verb: "hands off" },
            { to: "phone", verb: "relays" },
          ],
        }),
      ],
      "All features",
    );
    expect(story.cast).toEqual(["mac", "build", "phone"]);
    expect(story.links).toEqual([
      { to: "phone", verb: "asks you" },
      { to: "build", verb: "hands off" },
    ]);
  });

  it("a feature's sentence stops at the first sentence, whatever punctuation is inside it", () => {
    expect(firstSentence("Plans, a seat, a spare: add them all. Then more.")).toBe(
      "Plans, a seat, a spare: add them all.",
    );
    expect(firstSentence("ace for iPhone and iPad connects. It isn't a viewer.")).toBe(
      "ace for iPhone and iPad connects.",
    );
    expect(firstSentence("Only one sentence here.")).toBe("Only one sentence here.");
  });
});
