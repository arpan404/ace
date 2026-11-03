import { formatElapsed } from "@ace/ui-core/time";
import { scenes, type Act, type Root } from "./stage-scenes.ts";

/*
 * Plays the drawn Mac (components/mac/MacStory.astro): scales the desktop to its frame, ticks
 * running times, and plays a scene (stage-scenes.ts) as its marker crosses the middle of the
 * screen, or once in view on a feature page. It owns the pointers the scenes move. Scrolling to
 * another scene cancels the one playing; with reduced motion every scene jumps to its end.
 */

const q = (root: ParentNode, selector: string) => root.querySelector<HTMLElement>(selector);

export function startStageStory(root: Root): void {
  const mac = q(root, "[data-mac]");
  const desk = q(root, "[data-desktop]");
  const pointer = q(root, "[data-pointer]");
  if (!mac || !desk || !pointer) return;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const scale = () => mac.clientWidth / 1352;
  const fit = () => mac.style.setProperty("--desk-scale", String(scale()));
  new ResizeObserver(fit).observe(mac);
  fit();

  // Running times tick once a second, like the app's.
  const clocks = [...root.querySelectorAll<HTMLElement>("[data-seconds]")];
  setInterval(() => {
    if (document.hidden) return;
    for (const clock of clocks) {
      // A row that finished, waits on you or hit a limit shows no running time.
      if (clock.closest('[data-tone="done"], [data-tone="approve"], [data-tone="limited"]'))
        continue;
      const seconds = Number(clock.dataset.seconds) + 1;
      clock.dataset.seconds = String(seconds);
      clock.textContent = formatElapsed(seconds * 1000);
    }
  }, 1000);

  let run = 0;
  let current = -1;

  const place = (x: number, y: number) => {
    pointer.style.setProperty("--x", `${x}px`);
    pointer.style.setProperty("--y", `${y}px`);
  };
  place(900, 600);

  /** A point inside `target` (fractions of its box), in the desktop's own pixels. */
  const pointIn = (target: Element | null, at = { x: 0.5, y: 0.5 }) => {
    const s = scale();
    const box = desk.getBoundingClientRect();
    if (!target) return { x: 1352 * at.x, y: 880 * at.y };
    const r = target.getBoundingClientRect();
    return {
      x: (r.left - box.left + r.width * at.x) / s,
      y: (r.top - box.top + r.height * at.y) / s,
    };
  };

  const actFor = (token: number): Act => {
    const alive = () => token === run;
    const wait = (ms: number) =>
      new Promise<void>((done) => setTimeout(done, still || !alive() ? 0 : ms));
    const moveTo = async (target: Element | null, at?: { x: number; y: number }) => {
      if (!alive()) return;
      const p = pointIn(target, at);
      pointer.classList.add("shown");
      place(p.x, p.y);
      await wait(900);
    };
    return {
      alive,
      wait,
      moveTo,
      async click(target) {
        await moveTo(target, { x: 0.35, y: 0.5 });
        if (!alive()) return;
        pointer.classList.add("press");
        target?.classList.add("pressed");
        await wait(160);
        pointer.classList.remove("press");
        target?.classList.remove("pressed");
      },
      async tap(target) {
        if (!alive() || !target) return;
        const touch = q(root, "[data-touch]");
        const sim = q(root, "[data-sim]");
        if (!touch || !sim) return;
        const s = scale();
        const r = target.getBoundingClientRect();
        const frame = sim.getBoundingClientRect();
        touch.style.left = `${(r.left - frame.left + r.width / 2) / s}px`;
        touch.style.top = `${(r.top - frame.top + r.height / 2) / s}px`;
        await wait(500);
        touch.classList.add("down");
        for (const field of root.querySelectorAll(".field.focus")) field.classList.remove("focus");
        if (target.classList.contains("field")) target.classList.add("focus");
        await wait(220);
        touch.classList.remove("down");
        await wait(250);
      },
      async agentTo(target) {
        const cursor = q(root, "[data-agent-cursor]");
        const site = q(root, ".site");
        if (!alive() || !cursor || !site || !target) return;
        const s = scale();
        const r = target.getBoundingClientRect();
        const page = site.getBoundingClientRect();
        cursor.classList.add("shown");
        cursor.style.setProperty("--ax", `${(r.left - page.left + r.width * 0.55) / s}px`);
        cursor.style.setProperty("--ay", `${(r.top - page.top + r.height * 0.4) / s}px`);
        await wait(950);
      },
      hidePointer() {
        pointer.classList.remove("shown");
      },
      async type(target, text, mask = false) {
        if (!target) return;
        for (let i = 1; i <= text.length; i++) {
          if (!alive()) return;
          target.textContent = mask ? "•".repeat(i) : text.slice(0, i);
          await wait(55);
        }
      },
    };
  };

  function enter(index: number): void {
    if (index === current) return;
    current = index;
    for (const caption of root.querySelectorAll<HTMLElement>("[data-caption]")) {
      caption.classList.toggle("on", Number(caption.dataset.caption) === index);
    }
    const token = ++run;
    const id = markers[index]?.dataset.scene;
    const script = id ? scenes[id] : undefined;
    if (script) void script(root, actFor(token));
  }

  const markers = [...root.querySelectorAll<HTMLElement>("[data-scene]")];
  // A feature page's single scene plays once the Mac is mostly in view.
  const single = markers.length === 1;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) enter(markers.findIndex((marker) => marker === entry.target));
      }
    },
    single ? { threshold: 0.6 } : { rootMargin: "-50% 0px -50% 0px" },
  );
  for (const marker of markers) observer.observe(marker);
}
