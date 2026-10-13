import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, test, vi } from "vitest";
import { useHotkey } from "@/lib/hotkeys.ts";
import { Button } from "./button.tsx";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "./dialog.tsx";

/** A dialog with no trigger, opened by a shortcut (as Rename and Add project are). */
function ShortcutDialog(props: { onSave(): void; saveDisabled?: boolean }) {
  const [open, setOpen] = useState(false);
  useHotkey("alt+mod+r", () => setOpen(true));
  return (
    <>
      <textarea aria-label="Message" />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Rename</DialogTitle>
          <input aria-label="Title" />
          <DialogFooter submitHint>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={props.saveDisabled ?? false} onClick={props.onSave}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

test("a dialog opened by a shortcut gives focus back to where it was when it closes", async () => {
  render(<ShortcutDialog onSave={() => {}} />);
  const message = screen.getByRole("textbox", { name: "Message" });
  message.focus();
  await userEvent.keyboard("{Control>}{Alt>}r{/Alt}{/Control}");
  await screen.findByRole("dialog", { name: "Rename" });
  await waitFor(() => expect(document.activeElement).not.toBe(message));

  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(message);
});

test("with a submit hint, Ctrl+Enter presses the dialog's primary button, which shows the keys", async () => {
  const onSave = vi.fn();
  render(<ShortcutDialog onSave={onSave} />);
  await userEvent.keyboard("{Control>}{Alt>}r{/Alt}{/Control}");
  const title = await screen.findByRole("textbox", { name: "Title" });
  // The hint shows on the button but isn't part of its name.
  const save = screen.getByRole("button", { name: "Save" });
  expect(save.textContent).toBe("SaveCtrl+Enter");

  await userEvent.click(title);
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  expect(onSave).toHaveBeenCalledTimes(1);
});

test("the submit shortcut does nothing while the primary button is disabled", async () => {
  const onSave = vi.fn();
  render(<ShortcutDialog onSave={onSave} saveDisabled />);
  await userEvent.keyboard("{Control>}{Alt>}r{/Alt}{/Control}");
  await userEvent.click(await screen.findByRole("textbox", { name: "Title" }));
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  expect(onSave).not.toHaveBeenCalled();
});

test("a destructive confirmation opens on Cancel, ahead of its other controls, so Enter deletes nothing", async () => {
  const onDelete = vi.fn();
  render(
    <Dialog open>
      <DialogContent>
        <DialogTitle>Delete 3 files?</DialogTitle>
        <a href="#files">Show the files</a>
        <DialogFooter>
          <Button variant="ghost">Cancel</Button>
          <Button variant="danger" onClick={onDelete}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>,
  );
  const dialog = await screen.findByRole("dialog", { name: "Delete 3 files?" });
  const cancel = within(dialog).getByRole("button", { name: "Cancel" });
  await waitFor(() => expect(document.activeElement).toBe(cancel));
  expect(within(dialog).getByRole("button", { name: "Delete" }).dataset.variant).toBe("danger");

  await userEvent.keyboard("{Enter}");
  expect(onDelete).not.toHaveBeenCalled();
});

test("a dialog without a danger action keeps its usual first focus", async () => {
  render(
    <Dialog open>
      <DialogContent>
        <DialogTitle>Rename</DialogTitle>
        <input aria-label="Title" />
        <DialogFooter>
          <Button variant="ghost">Cancel</Button>
          <Button variant="primary">Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>,
  );
  const title = await screen.findByRole("textbox", { name: "Title" });
  await waitFor(() => expect(document.activeElement).toBe(title));
});
