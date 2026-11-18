import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { FileEditor, type FileDraft } from "./file-editor.tsx";

/*
 * FileEditor's side of the editing contract, with the network and the checkout stubbed: the
 * save takes the text exactly once, a busy save makes the surface read-only, and leaving the
 * editor keeps what was typed before the settle timer fires.
 */

const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("@ace/client-react", () => ({ useClient: () => ({}) }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: () => Promise.resolve() }),
  keepPreviousData: (value: unknown) => value,
}));
vi.mock("./file-management-source.ts", () => ({
  fileManagement: () => ({ mutate }),
}));
vi.mock("./use-checkout.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./use-checkout.ts")>()),
  useCheckoutSource: () => ({
    stat: () => Promise.resolve({ version: "2", size: 0, folder: false }),
  }),
}));

const draft: FileDraft = { text: "one", original: "one", version: "1" };

beforeEach(() => mutate.mockReset());

function mount(overrides: Partial<Parameters<typeof FileEditor>[0]> = {}) {
  const props = {
    threadId: "thread",
    path: "a.ts",
    draft,
    onChange: vi.fn(),
    onClose: vi.fn(),
    onSaved: vi.fn(),
    ...overrides,
  };
  const view = render(<FileEditor {...props} />);
  return { ...props, view };
}

async function editor() {
  const box = await screen.findByRole("textbox", { name: "a.ts" });
  await userEvent.click(box);
  await userEvent.keyboard("{Control>}{End}{/Control}");
  return box;
}

test("leaving the editor within the settle delay keeps the typed draft", async () => {
  const { onChange, view } = mount();
  await editor();
  await userEvent.keyboard("!");

  view.unmount();

  expect(onChange).toHaveBeenCalledWith({ ...draft, text: "one!" });
});

test("blurring the editor keeps the draft at once", async () => {
  const { onChange } = mount();
  const box = await editor();
  await userEvent.keyboard("?");

  fireEvent.blur(box);

  expect(onChange).toHaveBeenCalledWith({ ...draft, text: "one?" });
});

test("a save makes the editor read-only, and a cut while it runs changes nothing", async () => {
  let finish: ((value: { version: string }) => void) | undefined;
  mutate.mockImplementationOnce(
    () =>
      new Promise<{ version: string }>((resolve) => {
        finish = resolve;
      }),
  );
  const { onSaved } = mount();
  const box = await editor();
  await userEvent.keyboard("!");

  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(box).toHaveProperty("readOnly", true));

  fireEvent.cut(box, { clipboardData: { setData: () => undefined, getData: () => "" } });
  expect((box as HTMLTextAreaElement).value).toContain("one!");

  finish?.({ version: "2" });
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(mutate.mock.calls[0]?.[0]).toMatchObject({ op: "write", text: "one!" });
});
