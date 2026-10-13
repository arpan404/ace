import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { expect, test } from "vitest";
import { Command, CommandDialog, CommandInput } from "@/components/ui/command.tsx";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { focusOpenRequest } from "./focus-on-open.ts";

function Request(props: { pending: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (props.pending && root.current) return focusOpenRequest(root.current);
  }, [props.pending]);
  return (
    <div ref={root}>
      {props.pending && (
        <article aria-label="Approval">
          <div data-approval-deliberate>
            <button data-approval-refusal>Deny</button>
          </div>
        </article>
      )}
    </div>
  );
}

function Palette(props: { pending: boolean }) {
  return (
    <TooltipProvider>
      <Request pending={props.pending} />
      <CommandDialog open onOpenChange={() => {}}>
        <Command items={[]} itemToStringValue={(item: string) => item}>
          <CommandInput aria-label="Search commands" />
        </Command>
      </CommandDialog>
    </TooltipProvider>
  );
}

test("an incoming request preserves the command dialog's search focus", async () => {
  const view = render(<Palette pending={false} />);
  const search = await screen.findByRole("combobox", { name: "Search commands" });
  await waitFor(() => expect(document.activeElement).toBe(search));
  view.rerender(<Palette pending />);
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expect(document.activeElement).toBe(search);
});

test("a hidden sheet does not prevent the incoming request from focusing Deny", async () => {
  const view = render(
    <>
      <div data-slot="sheet-content" role="dialog" hidden />
      <Request pending={false} />
    </>,
  );
  view.rerender(
    <>
      <div data-slot="sheet-content" role="dialog" hidden />
      <Request pending />
    </>,
  );
  const deny = screen.getByRole("button", { name: "Deny" });
  await waitFor(() => expect(document.activeElement).toBe(deny));
});

test("an error toast does not prevent the incoming request from focusing Deny", async () => {
  const view = render(
    <>
      <div role="alertdialog" aria-modal="false">
        A command failed
      </div>
      <Request pending={false} />
    </>,
  );
  view.rerender(
    <>
      <div role="alertdialog" aria-modal="false">
        A command failed
      </div>
      <Request pending />
    </>,
  );
  const deny = screen.getByRole("button", { name: "Deny" });
  await waitFor(() => expect(document.activeElement).toBe(deny));
});

function Thread(props: { carded: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => (root.current ? focusOpenRequest(root.current) : undefined), []);
  return (
    <div ref={root}>
      <div role="feed" aria-label="Transcript">
        <article aria-label="Question: Which screens should change?">
          <button type="button">Show all 3 options</button>
        </article>
      </div>
      {props.carded && (
        <article aria-label="Which screens should change?">
          <button type="button">Skip</button>
        </article>
      )}
    </div>
  );
}

const frame = () =>
  act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

test("a request's record in the transcript never takes focus while its card loads", async () => {
  const view = render(<Thread carded={false} />);
  await frame();
  await frame();
  const transcript = screen.getByRole("feed", { name: "Transcript" });
  expect(transcript.contains(document.activeElement)).toBe(false);
  view.rerender(<Thread carded />);
  const skip = screen.getByRole("button", { name: "Skip" });
  await waitFor(() => expect(document.activeElement).toBe(skip));
});
