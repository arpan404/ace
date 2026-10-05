import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { brandArt } from "@ace/ui-core/provider-icons";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { ProviderIcon, ProviderIconTip } from "./provider-icons.tsx";

test("a provider icon names the provider and draws its mark once loaded", async () => {
  render(<ProviderIcon provider="codex" size={16} />);
  const icon = await screen.findByRole("img", { name: "Codex" });
  expect(icon.getAttribute("width")).toBe("16");
  await waitFor(() => expect(icon.querySelector("path")).not.toBeNull());
});

test("an ACP agent's icon is named by its registry name", async () => {
  render(<ProviderIcon provider="acp" acpAgentId="official:gemini" />);
  expect(await screen.findByRole("img", { name: "Gemini CLI" })).toBeTruthy();
});

test("an agent without a brand draws the neutral glyph rather than nothing", async () => {
  render(<ProviderIcon provider="acp" acpAgentId="local:house-reviewer" />);
  const icon = screen.getByRole("img", { name: "house-reviewer" });
  await waitFor(() => expect(icon.querySelector("circle")).not.toBeNull());
});

test("a decorative icon beside its provider's name stays out of the accessibility tree", () => {
  render(
    <span>
      <ProviderIcon provider="pi" decorative /> Pi
    </span>,
  );
  expect(screen.queryByRole("img")).toBeNull();
});

test("the tip names the provider on hover", async () => {
  render(<ProviderIconTip provider="pi" />);
  await userEvent.hover(screen.getByRole("img", { name: "Pi" }));
  expect(await screen.findByText("Pi")).toBeTruthy();
});

test("Claude draws in its brand orange unless asked for mono, which takes the text colour", async () => {
  const { unmount } = render(<ProviderIcon provider="claude" size={16} />);
  const icon = await screen.findByRole("img", { name: "Claude Code" });
  await waitFor(() => expect(icon.querySelector("path")?.getAttribute("fill")).toBe("#D97757"));
  unmount();
  render(<ProviderIcon provider="claude" size={16} variant="mono" />);
  const mono = await screen.findByRole("img", { name: "Claude Code" });
  await waitFor(() =>
    expect(mono.querySelector("path")?.getAttribute("fill")).toBe("currentColor"),
  );
});

test("each Codex mark paints with its own top-to-bottom gradient", async () => {
  render(
    <>
      <ProviderIcon provider="codex" size={20} label="first" />
      <ProviderIcon provider="codex" size={20} label="second" />
    </>,
  );
  const gradients = await Promise.all(
    ["first", "second"].map(async (name) => {
      const icon = await screen.findByRole("img", { name });
      await waitFor(() => expect(icon.querySelector("linearGradient")).not.toBeNull());
      const fill = icon.querySelector("path")?.getAttribute("fill") ?? "";
      const id = /^url\(#(.+)\)$/.exec(fill)?.[1] ?? "";
      // The fill resolves inside this very mark, not a sibling's defs.
      const gradient = [...icon.querySelectorAll("linearGradient")].find((g) => g.id === id);
      expect(gradient).toBeDefined();
      return gradient;
    }),
  );
  expect(gradients[0]?.id).not.toBe(gradients[1]?.id);
  for (const gradient of gradients)
    expect(["x1", "y1", "x2", "y2"].map((name) => gradient?.getAttribute(name))).toEqual([
      "12",
      "3",
      "12",
      "21",
    ]);
});

/** A gradient as the browser reads it from an SVG document: what a mark must keep. */
function readGradient(element: Element) {
  const attributes = Object.fromEntries(
    [...element.attributes].filter((a) => a.name !== "id").map((a) => [a.name, a.value]),
  );
  const stops = [...element.querySelectorAll("stop")].map((stop) => ({
    offset: stop.getAttribute("offset") ?? "0",
    color: stop.getAttribute("stop-color"),
    opacity: stop.hasAttribute("stop-opacity") ? Number(stop.getAttribute("stop-opacity")) : 1,
  }));
  return { type: element.localName.startsWith("radial") ? "radial" : "linear", attributes, stops };
}

test("every colour mark keeps its source's gradient geometry and stops", async () => {
  const icons = join(
    dirname(createRequire(import.meta.url).resolve("@lobehub/icons-static-svg/package.json")),
    "icons",
  );
  for (const [brand, loadArt] of Object.entries(brandArt)) {
    const art = await loadArt();
    if (!art.color) continue;
    const source = new DOMParser().parseFromString(
      readFileSync(join(icons, `${brand}-color.svg`), "utf8"),
      "image/svg+xml",
    );
    const expected = [...source.querySelectorAll("path")].flatMap((path) => {
      const id = /^url\(#(.+)\)$/.exec(path.getAttribute("fill") ?? "")?.[1];
      const element = id ? source.getElementById(id) : null;
      return element ? [readGradient(element)] : [];
    });
    const kept = art.color.flatMap((path) =>
      path.gradient
        ? [
            {
              type: path.gradient.type,
              attributes: path.gradient.attributes,
              stops: path.gradient.stops.map((stop) => ({ ...stop, opacity: stop.opacity ?? 1 })),
            },
          ]
        : [],
    );
    expect(kept, brand).toEqual(expected);
  }
});
