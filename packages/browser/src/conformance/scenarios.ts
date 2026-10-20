import type { ConformanceScenario } from "./engine.ts";
import { annotationScenarios } from "./scenarios-annotation.ts";
import { contentScenarios } from "./scenarios-content.ts";
import { interactionScenarios } from "./scenarios-interaction.ts";
import { navigationScenarios } from "./scenarios-navigation.ts";
import { pageScenarios } from "./scenarios-page.ts";
import { tabScenarios } from "./scenarios-tabs.ts";

/** Every scenario, in the order the suite runs them. Ids are what engines key their notes by. */
export const scenarios: readonly ConformanceScenario[] = [
  ...navigationScenarios,
  ...interactionScenarios,
  ...tabScenarios,
  ...pageScenarios,
  ...contentScenarios,
  ...annotationScenarios,
];
