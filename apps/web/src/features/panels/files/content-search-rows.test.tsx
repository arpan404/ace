import { configure, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { openSearch } from "./content-search-test-support.ts";

configure({ asyncUtilTimeout: 10000 });

const results = (panel: HTMLElement) =>
  within(panel).findByRole("list", { name: "Search results" });

test("a file row shows its whole name before its folder; line numbers share one width", async () => {
  const lines = Array.from({ length: 130 }, (_, index) => (index === 121 ? "quokka" : "-"));
  const { panel, field } = await openSearch({
    files: { "packages/deep/folder/providers-clean-shots.ts": `${lines.join("\n")}\n` },
  });
  await userEvent.type(field, "quokka");
  const list = await results(panel);
  const row = await within(list).findByRole("button", {
    name: "packages/deep/folder/providers-clean-shots.ts, 1 result",
  });
  expect(row.getAttribute("title")).toBe("packages/deep/folder/providers-clean-shots.ts");
  expect(row.querySelector('[data-part="search-file-name"]')?.textContent).toBe(
    "providers-clean-shots.ts",
  );
  await within(list).findByRole("button", { name: /line 122: quokka$/ });
  const widths = [...list.querySelectorAll<HTMLElement>('[data-part="search-line-number"]')].map(
    (number) => number.style.width,
  );
  expect(new Set(widths)).toEqual(new Set(["3ch"]));
});
