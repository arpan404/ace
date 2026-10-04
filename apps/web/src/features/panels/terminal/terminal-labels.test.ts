import { expect, test } from "vitest";
import { distinctLabels } from "./use-terminals.ts";

test("terminal tabs with the same name read apart", () => {
  const labels = distinctLabels([
    { label: "dev:relay" },
    { label: "soak" },
    { label: "dev:relay" },
    { label: "dev:relay" },
  ]).map((tab) => tab.label);
  expect(labels).toEqual(["dev:relay", "soak", "dev:relay 2", "dev:relay 3"]);
});
