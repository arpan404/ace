import { formatElapsed } from "@ace/ui-core/time";

/*
 * Plays the home page's Mac (components/mac/MacStory.astro). Each scene sets the drawn app to
 * where it starts, then a pointer acts it out: moving to real elements of the drawing and
 * "clicking" them, which flips the `data-*` state the CSS reads. Scrolling to another scene
 * cancels the one playing. With reduced motion every scene jumps straight to its end.
 */

type Root = HTMLElement;

interface Act {
  /** False once another scene has started; every step checks it. */
  alive(): boolean;
  wait(ms: number): Promise<void>;
  moveTo(target: Element | null, at?: { x: number; y: number }): Promise<void>;
  click(target: Element | null): Promise<void>;
  type(target: Element | null, text: string, mask?: boolean): Promise<void>;
  tap(target: Element | null): Promise<void>;
}

type SceneScript = (root: Root, act: Act) => Promise<void>;

const scenes: Record<string, SceneScript> = {
  async agents(root, act) {
    show(root, { thread: "cold-start" });
    await act.wait(500);
    await act.moveTo(q(root, '[data-target="subagents"]'), { x: 0.3, y: 0.5 });
    hover(root, '[data-target="subagents"]', true);
  },

  async approve(root, act) {
    show(root, { thread: "cold-start" });
    await act.wait(400);
    q(root, "[data-note]")?.classList.add("on");
    await act.wait(1500);
    if (!act.alive()) return;
    await act.click(q(root, '[data-row="checkout"]'));
    q(root, "[data-note]")?.classList.remove("on");
    select(root, "checkout");
    await act.wait(1300);
    await act.click(q(root, '[data-target="allow"]'));
    if (!act.alive()) return;
    q(root, "[data-ace]")?.setAttribute("data-approved", "yes");
    tone(root, "checkout", "done", "now");
    await act.wait(300);
    await act.moveTo(q(root, ".canvas .reply.after-approval"), { x: 0.6, y: 1.6 });
  },

  async review(root, act) {
    show(root, { thread: "cold-start", approved: true });
    await act.wait(400);
    await act.click(q(root, ".actions .flip"));
    if (!act.alive()) return;
    q(root, "[data-ace]")?.setAttribute("data-panel", "on");
    await act.wait(900);
    const added = q(root, ".changes .line.add");
    await act.moveTo(added, { x: 0.45, y: 0.5 });
    added?.classList.add("hover");
    await act.wait(1100);
    added?.classList.remove("hover");
    await act.moveTo(q(root, '[data-target="commit"]'), { x: 0.4, y: 0.5 });
    hover(root, '[data-target="commit"]', true);
  },

  async computer(root, act) {
    show(root, { thread: "cold-start", approved: true });
    await act.wait(300);
    await act.click(q(root, '[data-row="sign-in"]'));
    if (!act.alive()) return;
    select(root, "sign-in");
    await act.wait(500);
    desktop(root)?.setAttribute("data-sim-shown", "");
    await act.moveTo(null, { x: 0.45, y: 0.94 });
    const note = q(root, "[data-sim-note]");
    await act.wait(900);
    if (note) note.textContent = "Typing in Email";
    await act.tap(q(root, '[data-target="sim-email"]'));
    await act.type(q(root, '[data-type="email"]'), "test@acme.dev");
    await act.tap(q(root, '[data-target="sim-password"]'));
    await act.type(q(root, '[data-type="password"]'), "hunter2-acme", true);
    if (note && act.alive()) note.textContent = "Tapped Sign in";
    await act.tap(q(root, '[data-target="sim-submit"]'));
    if (!act.alive()) return;
    q(root, "[data-sim]")?.setAttribute("data-screen", "code");
    if (note) note.textContent = "On the code screen";
  },

  async fleet(root, act) {
    show(root, { thread: "cold-start", approved: true });
    await act.wait(400);
    await act.click(q(root, '[data-target="filter"]'));
    if (!act.alive()) return;
    q(root, "[data-menu]")?.classList.add("open");
    await act.wait(500);
    await act.moveTo(q(root, '[data-target="machine-build-server"]'), { x: 0.3, y: 0.5 });
    hover(root, '[data-target="machine-build-server"]', true);
    await act.wait(600);
    await act.click(q(root, '[data-target="machine-build-server"]'));
    if (!act.alive()) return;
    q(root, "[data-menu]")?.classList.remove("open");
    q(root, "[data-ace]")?.setAttribute("data-filter", "build-server");
    await act.wait(300);
    await act.moveTo(q(root, '[data-row="worktrees"]'), { x: 0.55, y: 0.5 });
  },
};

const q = (root: ParentNode, selector: string) => root.querySelector<HTMLElement>(selector);
const desktop = (root: Root) => q(root, "[data-desktop]");

function hover(root: Root, selector: string, on: boolean): void {
  q(root, selector)?.classList.toggle("hover", on);
}

function select(root: Root, id: string): void {
  for (const row of root.querySelectorAll<HTMLElement>("[data-row]")) {
    row.classList.toggle("selected", row.dataset.row === id);
  }
  q(root, "[data-ace]")?.setAttribute("data-thread", id);
}

function tone(root: Root, id: string, kind: string, label?: string): void {
  const row = q(root, `[data-row="${id}"]`);
  if (!row) return;
  row.dataset.tone = kind;
  const time = q(row, ".time");
  if (time && label !== undefined) time.textContent = label;
}

/** Every scene starts from the same app: one thread open, nothing pressed, nothing open. */
function show(root: Root, state: { thread: string; approved?: boolean }): void {
  const ace = q(root, "[data-ace]");
  if (!ace) return;
  select(root, state.thread);
  ace.setAttribute("data-panel", "off");
  ace.setAttribute("data-filter", "all");
  ace.setAttribute("data-approved", state.approved ? "yes" : "no");
  tone(root, "checkout", state.approved ? "done" : "approve", state.approved ? "now" : "");
  desktop(root)?.removeAttribute("data-sim-shown");
  q(root, "[data-note]")?.classList.remove("on");
  q(root, "[data-menu]")?.classList.remove("open");
  for (const element of root.querySelectorAll(".hover")) element.classList.remove("hover");
  const sim = q(root, "[data-sim]");
  sim?.setAttribute("data-screen", "sign-in");
  for (const field of root.querySelectorAll("[data-type]")) field.textContent = "";
  for (const field of root.querySelectorAll(".field.focus")) field.classList.remove("focus");
  const note = q(root, "[data-sim-note]");
  if (note) note.textContent = "Opening Acme";
}

export function startStageStory(root: Root): void {
  const mac = q(root, "[data-mac]");
  const desk = desktop(root);
  const pointer = q(root, "[data-pointer]");
  if (!mac || !desk || !pointer) return;
  q(root, ".ace")?.setAttribute("data-ace", "");
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
