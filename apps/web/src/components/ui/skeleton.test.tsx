import { act, render } from "@testing-library/react";
import { expect, test } from "vitest";
import { createStartup, StartupContext, useStartupShell } from "@/lib/startup/startup.tsx";
import { ListSkeleton, LoadingRegion } from "./skeleton.tsx";

/** A startup whose timers never run and whose frames run when the test says. */
function startupAtBoot() {
  const frames: (() => void)[] = [];
  const startup = createStartup({
    schedule: () => () => {},
    frame(run) {
      frames.push(run);
      return () => frames.splice(frames.indexOf(run), 1);
    },
  });
  return { startup, paint: () => act(() => frames.splice(0).forEach((run) => run())) };
}

function Shell(props: { children: React.ReactNode }) {
  useStartupShell(true);
  return <main>{props.children}</main>;
}

function bootWith(children: React.ReactNode) {
  const { startup, paint } = startupAtBoot();
  render(
    <StartupContext value={startup}>
      <Shell>{children}</Shell>
    </StartupContext>,
  );
  paint();
  return startup.getSnapshot().phase;
}

test("the sidebar's thread list loading keeps the startup screen up", () => {
  expect(bootWith(<ListSkeleton label="threads" shape="thread" />)).toBe("loading");
});

test("a slow panel's skeleton lets the first screen show", () => {
  expect(
    bootWith(
      <>
        <ListSkeleton label="automations" shape="row" />
        <ListSkeleton label="approvals" shape="card" />
        <LoadingRegion label="usage">…</LoadingRegion>
      </>,
    ),
  ).toBe("leaving");
});
