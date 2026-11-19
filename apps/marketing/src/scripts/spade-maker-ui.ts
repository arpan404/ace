import {
  botFaceColourVars,
  botFaceMarkup,
  botFacePartField,
  repairFace,
  shuffleFace,
  stepFace,
  type BotFace,
  type BotFaceField,
} from "@ace/ui-core/bot-face";
import { cueFace, lookAt, startCast } from "./spade-cast.ts";
import { gazeToward } from "./spade-gaze.ts";
import {
  choosePart,
  makerParts,
  optionName,
  partOpen,
  partOptions,
  shownName,
} from "./spade-maker.ts";
import { tabAfter } from "./spade-tabs.ts";

/*
 * Runs the /spade/ page's face maker (components/spade/Maker.astro): draws the face and the
 * chosen part's options with the app's geometry, applies a choice, a Shuffle or a click on a
 * drawn part, and shows the typed name and task under the face. The face hops when it changes
 * and looks at the field being typed in. Nothing leaves the page.
 */

const bigSize = 168;
const optionSize = 34;

/** Paints a face into an existing <svg>, so the element (and its live wiring) stays. */
function paint(svg: SVGElement, face: BotFace, size: number, uid: string): void {
  svg.innerHTML = botFaceMarkup(face, size, uid);
  for (const [name, value] of Object.entries(botFaceColourVars(face)))
    svg.style.setProperty(name, value);
}

function optionButton(
  face: BotFace,
  field: BotFaceField,
  label: string,
  value: string,
  index: number,
) {
  const button = document.createElement("button");
  const chosen = face[field] === value;
  button.type = "button";
  button.className = "option";
  button.setAttribute("role", "radio");
  button.setAttribute("aria-checked", chosen ? "true" : "false");
  button.setAttribute("aria-label", `${label}: ${optionName(value)}`);
  button.tabIndex = chosen ? 0 : -1;
  button.dataset.value = value;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(optionSize));
  svg.setAttribute("height", String(optionSize));
  svg.setAttribute("overflow", "visible");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("bot-face");
  svg.dataset.state = "idle";
  paint(svg, choosePart(face, field, value), optionSize, `maker-o${index}`);
  button.append(svg);
  return button;
}

export function startMaker(root: HTMLElement): void {
  const big = root.querySelector<SVGElement>("svg.big");
  const options = root.querySelector<HTMLElement>("[data-options]");
  const name = root.querySelector<HTMLInputElement>("[data-name]");
  const task = root.querySelector<HTMLInputElement>("[data-task]");
  const shownNameAt = root.querySelector<HTMLElement>("[data-shown-name]");
  const shownTaskAt = root.querySelector<HTMLElement>("[data-shown-task]");
  const partButtons = [...root.querySelectorAll<HTMLButtonElement>("[data-part-field]")];
  if (!big || !options || !name || !task || !shownNameAt || !shownTaskAt) return;

  let face: BotFace = repairFace(JSON.parse(root.dataset.face ?? "{}") as Record<string, unknown>);
  let field: BotFaceField = "body";
  // Options are copied for the scoped styles the server gave the first ones.
  const scope = [...(options.firstElementChild?.attributes ?? [])].find((at) =>
    at.name.startsWith("data-astro-cid"),
  )?.name;

  const drawOptions = (focus: boolean) => {
    const label = makerParts.find((part) => part.field === field)?.label ?? field;
    options.setAttribute("aria-label", label);
    const buttons = partOptions(face, field).map((value, index) =>
      optionButton(face, field, label, value, index),
    );
    if (scope) for (const button of buttons) button.setAttribute(scope, "");
    options.replaceChildren(...buttons);
    if (focus) options.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  };

  const drawParts = () => {
    for (const button of partButtons) {
      const own = button.dataset.partField as BotFaceField;
      button.disabled = !partOpen(face, own);
      button.setAttribute("aria-pressed", own === field ? "true" : "false");
    }
  };

  const drawName = () => {
    shownNameAt.textContent = shownName(face, name.value);
    name.placeholder = shownName(face, "");
    shownTaskAt.textContent = task.value.trim();
  };

  const change = (next: BotFace, focus = false) => {
    if (next === face) return;
    face = next;
    if (!partOpen(face, field)) field = "body";
    paint(big, face, bigSize, "maker-big");
    cueFace(big, "hop");
    drawParts();
    drawOptions(focus);
    drawName();
  };

  for (const button of partButtons) {
    button.addEventListener("click", () => {
      field = button.dataset.partField as BotFaceField;
      drawParts();
      drawOptions(false);
    });
  }

  options.addEventListener("click", (event) => {
    const button =
      event.target instanceof Element ? event.target.closest<HTMLElement>("[data-value]") : null;
    if (button?.dataset.value) change(choosePart(face, field, button.dataset.value), true);
  });
  // Arrows move the choice along the row, as a radio group does.
  options.addEventListener("keydown", (event) => {
    const values = partOptions(face, field);
    const next = tabAfter(event.key, values.indexOf(face[field]), values.length);
    const value = next === undefined ? undefined : values[next];
    if (value === undefined) return;
    event.preventDefault();
    change(choosePart(face, field, value), true);
  });

  root.querySelector("[data-shuffle]")?.addEventListener("click", () => {
    change(shuffleFace(Math.random, face));
  });

  // A click on a drawn part steps that part, as on the app's big face.
  big.addEventListener("click", (event) => {
    const part = event.target instanceof Element ? event.target.closest("[data-part]") : null;
    const stepped = botFacePartField[part?.getAttribute("data-part") ?? ""];
    if (!stepped) return;
    field = stepped;
    change(stepFace(face, stepped));
  });

  // While a field is being typed in, the face watches it.
  for (const input of [name, task]) {
    input.addEventListener("input", drawName);
    input.addEventListener("focus", () => {
      const box = input.getBoundingClientRect();
      lookAt(
        big,
        gazeToward(big.getBoundingClientRect(), { x: box.left + 24, y: box.top + box.height / 2 }),
      );
    });
    input.addEventListener("blur", () => lookAt(big, undefined));
  }

  startCast(root);
}
