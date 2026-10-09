import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { ProjectIconField } from "./project-icon-field.tsx";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("upload resizes and releases its decoded image before returning PNG artwork", async () => {
  const close = vi.fn();
  const drawImage = vi.fn();
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 640, height: 320, close }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    vi.fn().mockReturnValue({ drawImage }),
  );
  const png = "data:image/png;base64,aGVsbG8=";
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(png);
  const change = vi.fn();
  const busy = vi.fn();
  render(<ProjectIconField name="Website" value={null} onChange={change} onBusy={busy} />);
  await userEvent.upload(
    screen.getByLabelText("Upload project icon"),
    new File(["png"], "site.png", { type: "image/png" }),
  );
  await waitFor(() => expect(change).toHaveBeenCalledWith(png));
  expect(drawImage.mock.calls[0]?.slice(1)).toEqual([0, 0, 64, 32]);
  expect(close).toHaveBeenCalledOnce();
  expect(busy.mock.calls.map(([value]) => value)).toEqual([true, false]);
});

test("failed image decoding preserves the draft and lets the user retry", async () => {
  vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("Image decode failed")));
  const change = vi.fn();
  const busy = vi.fn();
  render(
    <ProjectIconField
      name="Website"
      value="https://example.test/old.png"
      onChange={change}
      onBusy={busy}
    />,
  );
  await userEvent.upload(
    screen.getByLabelText("Upload project icon"),
    new File(["broken"], "site.png", { type: "image/png" }),
  );
  await screen.findByText("Image decode failed");
  expect(change).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "Icon URL" })).toHaveProperty(
    "value",
    "https://example.test/old.png",
  );
  expect(screen.getByRole("button", { name: "Upload image" })).toHaveProperty("disabled", false);
  expect(busy.mock.calls.map(([value]) => value)).toEqual([true, false]);
});

test("canvas encoding failures still release the decoded image", async () => {
  const close = vi.fn();
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 64, height: 64, close }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const change = vi.fn();
  render(<ProjectIconField name="Website" value={null} onChange={change} />);
  await userEvent.upload(
    screen.getByLabelText("Upload project icon"),
    new File(["png"], "site.png", { type: "image/png" }),
  );
  await screen.findByText("That image couldn't be read.");
  expect(close).toHaveBeenCalledOnce();
  expect(change).not.toHaveBeenCalled();
});
