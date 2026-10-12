import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
import { themes } from "@/theme/palettes.ts";

const root = document.documentElement;
afterEach(() => {
  for (const name of [
    "data-theme",
    "data-scheme",
    "data-surface",
    "data-reduce-motion",
    "data-density",
    "data-glass-engine",
    "style",
  ])
    root.removeAttribute(name);
});

interface Prefers {
  dark?: boolean;
  reducedMotion?: boolean;
  reducedTransparency?: boolean;
}
function system(prefers: Prefers) {
  return (query: string) =>
    ({
      matches:
        (query.includes("color-scheme: dark") && Boolean(prefers.dark)) ||
        (query.includes("reduced-motion") && Boolean(prefers.reducedMotion)) ||
        (query.includes("reduced-transparency") && Boolean(prefers.reducedTransparency)),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList;
}

/** Waits for the route's focus move to the title, so a click's focus isn't taken back. */
async function settled() {
  await waitFor(() => expect(document.activeElement?.tagName).toBe("H1"));
}

test("picking a theme applies it at once and the next load replays it before first paint", async () => {
  const storage = memoryKeyValue();
  const first = await harness({ storage, matchMedia: system({}) }).open("/settings/appearance");
  expect(root.getAttribute("data-theme")).toBe("ace");
  await settled();

  await userEvent.click(screen.getByRole("radio", { name: "Tide" }));
  expect(root.getAttribute("data-theme")).toBe("tide");
  expect(screen.getByRole("radio", { name: "Tide" }).getAttribute("aria-checked")).toBe("true");
  // index.html replays this record before the app's script runs.
  await waitFor(() => {
    const boot = JSON.parse(storage.getItem("ace.boot-appearance") ?? "{}");
    expect(boot).toMatchObject({ theme: "tide", mode: "system" });
    expect(boot.css).toContain('[data-theme="tide"][data-scheme="dark"]');
  });

  first.unmount();
  root.removeAttribute("data-theme");
  await harness({ storage }).open("/settings/appearance");
  await waitFor(() => expect(root.getAttribute("data-theme")).toBe("tide"));
});

test("mode is separate from theme: System follows the OS and Dark keeps the theme", async () => {
  await harness({ matchMedia: system({ dark: false }) }).open("/settings/appearance");
  expect(root.getAttribute("data-scheme")).toBe("light");
  // The browser's own bar takes the page's background.
  expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(
    themes.ace.light.s0,
  );
  await settled();
  await userEvent.click(screen.getByRole("radio", { name: "Moss" }));
  await userEvent.click(screen.getByRole("button", { name: "Dark" }));
  expect(root.getAttribute("data-scheme")).toBe("dark");
  expect(root.getAttribute("data-theme")).toBe("moss");
});

test("the theme swatches can be changed by keyboard", async () => {
  await harness().open("/settings/appearance");
  const ace = await screen.findByRole("radio", { name: "Ace" });
  expect(ace.getAttribute("tabindex")).toBe("0");
  await settled();
  ace.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(root.getAttribute("data-theme")).toBe("paper");
  expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Paper" }));
});

test("Solid surfaces turn glass off, and the OS reducing transparency does the same", async () => {
  const first = await harness({ matchMedia: system({}) }).open("/settings/appearance");
  expect(root.getAttribute("data-surface")).toBe("translucent");
  await settled();
  await userEvent.click(screen.getByRole("button", { name: "Solid" }));
  expect(root.getAttribute("data-surface")).toBe("solid");
  first.unmount();

  await harness({ matchMedia: system({ reducedTransparency: true }) }).open("/settings/appearance");
  expect(root.getAttribute("data-surface")).toBe("solid");
  expect(await screen.findByText("Solid while your system reduces transparency")).toBeTruthy();
});

test("Reduce motion follows the OS under System, and On or Off overrides it", async () => {
  await harness({ matchMedia: system({ reducedMotion: true }) }).open("/settings/appearance");
  expect(root.hasAttribute("data-reduce-motion")).toBe(true);
  await settled();
  await userEvent.click(screen.getByRole("button", { name: "Off" }));
  expect(root.hasAttribute("data-reduce-motion")).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "On" }));
  expect(root.hasAttribute("data-reduce-motion")).toBe(true);
});

test("density applies to the document", async () => {
  await harness().open("/settings/appearance");
  const compact = await screen.findByRole("button", { name: "Compact" });
  await settled();
  await userEvent.click(compact);
  expect(root.getAttribute("data-density")).toBe("compact");
});
