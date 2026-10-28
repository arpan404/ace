import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { OpenStepsContext, useGroupOpen, useOpenSteps, useStepOpen } from "./step-open.ts";

function Step(props: { id: string; rendered(): void }) {
  props.rendered();
  const [open, setOpen] = useStepOpen(props.id);
  return (
    <button onClick={() => setOpen(!open)}>
      {props.id}: {String(open === true)}
    </button>
  );
}
function Group(props: { ids: readonly string[] }) {
  const [open, setOpen] = useGroupOpen("group", props.ids);
  return <button onClick={() => setOpen(!open)}>Group: {String(open)}</button>;
}
function Log(props: { ids: readonly string[]; renderedA(): void; renderedB(): void }) {
  const store = useOpenSteps();
  return (
    <OpenStepsContext value={store}>
      <Step id="a" rendered={props.renderedA} />
      <Step id="b" rendered={props.renderedB} />
      <Group ids={props.ids} />
    </OpenStepsContext>
  );
}

test("opening a step leaves unrelated readers alone and follows it when groups change", () => {
  let a = 0;
  let b = 0;
  const renderedA = () => a++;
  const renderedB = () => b++;
  const view = render(<Log ids={["a"]} renderedA={renderedA} renderedB={renderedB} />);
  const beforeA = a;
  const beforeB = b;
  fireEvent.click(screen.getByText("a: false"));
  expect(screen.getByText("a: true")).toBeTruthy();
  expect(screen.getByText("Group: true")).toBeTruthy();
  expect(a).toBeGreaterThan(beforeA);
  expect(b).toBe(beforeB);
  view.rerender(<Log ids={["b"]} renderedA={renderedA} renderedB={renderedB} />);
  expect(screen.getByText("a: true")).toBeTruthy();
  expect(screen.getByText("Group: false")).toBeTruthy();
  fireEvent.click(screen.getByText("b: false"));
  expect(screen.getByText("Group: true")).toBeTruthy();
  fireEvent.click(screen.getByText("Group: true"));
  fireEvent.click(screen.getByText("b: true"));
  fireEvent.click(screen.getByText("b: false"));
  expect(screen.getByText("Group: false")).toBeTruthy();
});
