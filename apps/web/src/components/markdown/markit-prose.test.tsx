import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkitProse } from "./markit-prose.tsx";

// jsdom has no Worker, so markit's renderer cannot start here: exactly the case of a desktop
// build whose policy blocked its WebAssembly. The answer must still read as its text.
describe("an answer stays readable whether or not markit can render it", () => {
  it("shows the message's text while markit cannot render it", async () => {
    render(<MarkitProse text={"Deleted **14** merged branches.\nAll remotes pruned."} />);
    expect(await screen.findByText(/Deleted \*\*14\*\* merged branches\./)).toBeTruthy();
    // Still there once markit's failed start has settled, never replaced by an empty block.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByText(/All remotes pruned\./)).toBeTruthy();
  });

  it("keeps the streaming cursor beside the text", () => {
    render(
      <MarkitProse text="Working" streaming tail={<span role="status" aria-label="Streaming" />} />,
    );
    expect(screen.getByText("Working")).toBeTruthy();
    expect(screen.getByRole("status", { name: "Streaming" })).toBeTruthy();
  });
});
