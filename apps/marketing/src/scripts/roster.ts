/*
 * Drives the agents index's dial (components/Agents.astro): seats each group's chips on the
 * dial beside the composer, turns it when a chip is clicked or an arrow key pressed, shows the
 * chosen agent in the composer's picker and its card beside the dial, and switches between the
 * built-in and ACP groups. The numbers come from roster-dial.ts and the home's dial.
 */
import { rosterDial, turn } from "./roster-dial.ts";
import { dialSeats, dialTrack, type Dial } from "./zoom-camera.ts";

const chip = { width: 184, height: 40 };

export function startRoster(root: HTMLElement): void {
  const stage = root.querySelector<HTMLElement>("[data-roster-stage]");
  const composer = root.querySelector<HTMLElement>("[data-roster-composer]");
  const picker = root.querySelector<HTMLElement>("[data-roster-model]");
  const track = root.querySelector<SVGPathElement>("[data-roster-track]");
  const reach = root.querySelector<SVGPathElement>("[data-roster-reach]");
  const tabs = [...root.querySelectorAll<HTMLElement>("[data-roster-group]")];
  const rings = [...root.querySelectorAll<HTMLElement>("[data-roster-ring]")];
  if (!stage || !composer || !picker || rings.length === 0) return;
  root.dataset.live = "";

  const seats = rings.map((ring) => [...ring.querySelectorAll<HTMLElement>("[data-roster-seat]")]);
  const chosen = rings.map(() => 0);
  const caret = picker.querySelector("svg:last-child")?.outerHTML ?? "";
  let group = 0;
  let dial: Dial | undefined;

  /** Shows the chosen agent of the current group: in its seat, the picker and the card. */
  function show(): void {
    const list = seats[group] ?? [];
    const at = chosen[group] ?? 0;
    list.forEach((seat, index) => {
      seat.setAttribute("aria-pressed", index === at ? "true" : "false");
      seat.tabIndex = index === at ? 0 : -1;
    });
    if (dial) {
      dialSeats(dial, list.length, at, chip).forEach((place, index) => {
        const seat = list[index];
        if (!seat) return;
        seat.style.translate = `${place.x}px ${place.y}px`;
        seat.style.scale = String(place.scale);
        seat.style.opacity = String(place.opacity);
        seat.toggleAttribute("data-out", place.opacity === 0);
      });
    }
    const seat = list[at];
    const mark = seat?.querySelector("svg")?.outerHTML ?? "";
    picker.innerHTML = `${mark}${seat?.textContent?.trim() ?? ""}${caret}`;
    for (const card of root.querySelectorAll<HTMLElement>("[data-roster-card]")) {
      card.hidden = card.dataset.rosterCard !== `${group}-${at}`;
    }
  }

  /** Places the dial beside the composer as the stage now stands. */
  function layout(): void {
    const origin = stage?.getBoundingClientRect();
    const box = composer?.getBoundingClientRect();
    if (!origin || !box || box.width === 0) return;
    dial = rosterDial({
      x: box.left - origin.left,
      y: box.top - origin.top,
      width: box.width,
      height: box.height,
    });
    track?.setAttribute("d", dialTrack(dial));
    reach?.setAttribute("d", `M${box.right - origin.left} ${dial.cy}H${dial.cx + dial.radius - 6}`);
    show();
  }

  function choose(index: number, focus = false): void {
    chosen[group] = index;
    show();
    if (focus) seats[group]?.[index]?.focus();
  }

  function switchGroup(index: number, focus = false): void {
    group = index;
    tabs.forEach((tab, at) => {
      tab.setAttribute("aria-selected", at === index ? "true" : "false");
      tab.tabIndex = at === index ? 0 : -1;
    });
    rings.forEach((ring, at) => {
      ring.hidden = at !== index;
    });
    show();
    if (focus) tabs[index]?.focus();
  }

  seats.forEach((list, ring) =>
    list.forEach((seat, index) => {
      seat.addEventListener("click", () => {
        if (ring === group) choose(index);
      });
      seat.addEventListener("keydown", (event) => {
        const next = turn(chosen[group] ?? 0, list.length, event.key);
        if (next === undefined) return;
        event.preventDefault();
        choose(next, true);
      });
    }),
  );

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => switchGroup(index));
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      switchGroup(turn(group, tabs.length, event.key) ?? group, true);
    });
  });

  new ResizeObserver(layout).observe(stage);
  show();
}
