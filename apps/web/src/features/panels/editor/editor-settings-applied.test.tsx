import { configure, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { memoryKeyValue } from "@/test/harness.tsx";
import { expand, openExplorer, row } from "../files/explorer-test-support.ts";

/*
 * Settings › Editor reaches the editor panel's open editors: the device's font size and spacing
 * set the rows the file is drawn on, and its display switches what is drawn around the text.
 */

configure({ asyncUtilTimeout: 10000 });

test("an editor draws its file with this device's font size, spacing and display choices", async () => {
  const storage = memoryKeyValue();
  storage.setItem(
    "ace.editor.preferences",
    JSON.stringify({ fontSize: 18, lineSpacing: 2, fontFamily: "Iosevka", indentGuides: false }),
  );
  const { panel, tree } = await openExplorer({ storage });
  const socket = "apps/web/src/relay/socket.ts";
  await expand(tree, ["apps/", "apps/web/", "apps/web/src/", "apps/web/src/relay/"]);
  await userEvent.click(await row(tree, socket));
  const source = await within(panel).findByRole("region", { name: `Source of ${socket}` });
  const second = await waitFor(() => {
    const found = source.querySelector<HTMLElement>('[data-line="1"]');
    if (!found) throw new Error("line 2 is not drawn yet");
    return found;
  });
  expect(second.style.top).toBe("36px");
  const frame = source.querySelector<HTMLElement>("[data-editor-frame]");
  expect(frame?.style.fontSize).toBe("18px");
  expect(frame?.style.fontFamily).toBe("Iosevka");
  expect(source.querySelectorAll("[data-indent-guide]")).toHaveLength(0);
});
