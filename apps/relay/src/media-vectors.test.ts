import { test, expect } from "vitest";
import { mediaVectors } from "../scripts/media-vectors.ts";
import {
  committedVectors,
  jsonValue,
} from "../../../packages/browser/scripts/media-vector-harness.ts";
test("committed media scenarios still match the producing implementation", async () => {
  const vectors = await mediaVectors();
  for (const [area, output] of Object.entries(vectors))
    expect(jsonValue(output), area).toEqual(committedVectors(area));
});
