import { expect, test } from "vitest";
import { cn } from "./cn.ts";

test("the app's font sizes and text colours both survive a merge", () => {
  expect(cn("text-ui text-muted-foreground", "text-primary-foreground").split(" ")).toEqual([
    "text-ui",
    "text-primary-foreground",
  ]);
  expect(cn("text-ui", "text-md")).toBe("text-md");
  expect(cn("text-prose text-foreground", "text-2xs")).toBe("text-foreground text-2xs");
});
