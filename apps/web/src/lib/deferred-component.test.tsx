import { Suspense } from "react";
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { deferredComponent } from "./deferred-component.tsx";

test("a failed prefetch leaves the view loadable on first use", async () => {
  let online = false;
  const view = deferredComponent(async () => {
    if (!online) throw new Error("Chunk unavailable");
    return () => <h2>Loaded view</h2>;
  });
  await expect(view.preload()).rejects.toThrow("Chunk unavailable");
  online = true;
  render(
    <Suspense fallback={null}>
      <view.Component />
    </Suspense>,
  );
  expect(await screen.findByRole("heading", { name: "Loaded view" })).toBeTruthy();
});
