import { changeFace, repairFace } from "@ace/ui-core/bot-face";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, test } from "vitest";
import type { AvatarDraft } from "./spade-avatar-choice.tsx";
import { FacePicker } from "./spade-face-picker.tsx";
import { sentAvatar } from "./spade-profile-actions.ts";

const start = changeFace(repairFace({ body: "round" }), "ears", "cat");

/** The picker over a draft the way the face's popover holds it, saving what `saved` last saw. */
function Harness(props: { onDraft(draft: AvatarDraft): void }) {
  const [draft, setDraft] = useState<AvatarDraft>({ kind: "face", face: start });
  return (
    <FacePicker
      value={draft}
      fallback={start}
      takenPairs={[]}
      onChange={(next) => {
        props.onDraft(next);
        setDraft(next);
      }}
      onReset={() => setDraft({ kind: "face", face: start })}
    />
  );
}

async function openAdvanced(saved: { draft?: AvatarDraft }) {
  render(<Harness onDraft={(draft) => (saved.draft = draft)} />);
  await userEvent.click(screen.getByRole("tab", { name: "Generate" }));
  await userEvent.click(screen.getByRole("button", { name: "Advanced" }));
}

test("Advanced picks an option for a part, and that is the face the popover saves", async () => {
  const saved: { draft?: AvatarDraft } = {};
  await openAdvanced(saved);
  const ears = within(screen.getByRole("radiogroup", { name: "Ears" }));
  expect(ears.getByRole("radio", { name: "Ears: cat" }).getAttribute("aria-checked")).toBe("true");

  await userEvent.click(ears.getByRole("radio", { name: "Ears: bunny" }));
  expect(ears.getByRole("radio", { name: "Ears: bunny" }).getAttribute("aria-checked")).toBe(
    "true",
  );
  const sent = saved.draft ? sentAvatar(saved.draft) : undefined;
  expect(sent).toMatchObject({ kind: "character", ears: "bunny", body: "round" });
});

test("options a part already worn rules out are not offered, so they can't be picked", async () => {
  const saved: { draft?: AvatarDraft } = {};
  await openAdvanced(saved);
  // Cat ears and things worn over the ears share a place.
  const extra = within(screen.getByRole("radiogroup", { name: "Extra" }));
  expect(extra.queryByRole("radio", { name: "Extra: headphones" })).toBeNull();
  expect(extra.queryByRole("radio", { name: "Extra: beanie" })).toBeNull();
  // Changing the ears to ones that allow them brings them back.
  await userEvent.click(
    within(screen.getByRole("radiogroup", { name: "Ears" })).getByRole("radio", {
      name: "Ears: nubs",
    }),
  );
  expect(
    within(screen.getByRole("radiogroup", { name: "Extra" })).getByRole("radio", {
      name: "Extra: headphones",
    }),
  ).toBeTruthy();
});

test("a part's dice changes only that part, and arrow keys move along its row", async () => {
  const saved: { draft?: AvatarDraft } = {};
  await openAdvanced(saved);
  const before = start;
  await userEvent.click(screen.getByRole("button", { name: "Shuffle eyes" }));
  const after = saved.draft?.kind === "face" ? saved.draft.face : undefined;
  expect(after).toMatchObject({ body: before.body, ears: before.ears, mouth: before.mouth });

  const eyes = within(screen.getByRole("radiogroup", { name: "Eyes" }));
  const checked = eyes
    .getAllByRole("radio")
    .find((each) => each.getAttribute("aria-checked") === "true");
  checked?.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(document.activeElement).not.toBe(checked);
  expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Eyes: /);
});
