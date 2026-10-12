import { test } from "@playwright/test";
import {
  installSplitAlignmentFixture,
  openSplitAlignment,
  expandSplitComment,
  scrollSplitAwayAndBack,
} from "../../src/split-alignment-checks.ts";

for (const theme of ["light", "dark"])
  test(`split rows stay aligned through wrapping, comments and virtualization in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(
      (appearance) =>
        localStorage.setItem(
          "ace.appearance",
          JSON.stringify(
            appearance.includes("-")
              ? { theme: appearance.split("-")[0], mode: appearance.split("-")[1] }
              : { mode: appearance },
          ),
        ),
      theme,
    );
    await installSplitAlignmentFixture(page);
    await openSplitAlignment(page, "");
    await expandSplitComment(page);
    await scrollSplitAwayAndBack(page);
  });
