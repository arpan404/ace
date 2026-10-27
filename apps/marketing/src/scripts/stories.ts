/*
 * The product panels act out their feature once they scroll into view: each story moves the
 * panel from its opening state through a few real steps to a resting one. `prepare` sets the
 * opening state before the panel is seen; `play` runs the steps. Without motion neither runs,
 * and every panel shows its resting markup. Styles are in styles/motion.css.
 */

interface Story {
  prepare?: (panel: HTMLElement) => void;
  play: (panel: HTMLElement) => void;
}

/** Runs each step at its time (ms after the story starts). */
function timeline(steps: [number, () => void][]): void {
  for (const [at, step] of steps) setTimeout(step, at);
}

/** Restarts a one-shot CSS animation class on an element. */
function replay(element: Element, className: string): void {
  element.classList.remove(className);
  // Reading layout here makes the browser see the class come back as a new animation.
  void element.getBoundingClientRect();
  element.classList.add(className);
}

function setStatus(row: HTMLElement | null, tone: string, word: string): void {
  if (!row) return;
  row.dataset.tone = tone;
  const label = row.querySelector<HTMLElement>(".status-word, [data-state]");
  if (label) {
    label.textContent = word;
    replay(label, "flip");
  }
}

const row = (panel: HTMLElement, key: string) =>
  panel.querySelector<HTMLElement>(`[data-key="${key}"]`);

/* Subagents finish, and only then does their parent thread turn Done. */
const status: Story = {
  play(board) {
    timeline([
      [1100, () => setStatus(row(board, "audit"), "done", "Done")],
      [
        1900,
        () => {
          const parent = row(board, "dedupe");
          setStatus(parent, "done", "Done");
          if (parent) replay(parent, "settled");
        },
      ],
      [
        3000,
        () => {
          const waiting = row(board, "retry");
          setStatus(waiting, "done", "Done");
          if (waiting) replay(waiting, "settled");
        },
      ],
    ]);
  },
};

/* The address types itself, then each tool call runs and shows its result, like a live log. */
const browser: Story = {
  prepare(panel) {
    const address = panel.querySelector<HTMLElement>("[data-type]");
    if (address) {
      address.dataset.full = address.textContent?.trim() ?? "";
      address.textContent = "";
    }
    for (const step of panel.querySelectorAll("[data-step]")) step.classList.add("pending");
  },
  play(panel) {
    const address = panel.querySelector<HTMLElement>("[data-type]");
    const full = address?.dataset.full ?? "";
    const typing = 26;
    if (address) {
      address.classList.add("typing");
      [...full].forEach((_, index) =>
        setTimeout(() => (address.textContent = full.slice(0, index + 1)), 300 + index * typing),
      );
      setTimeout(() => address.classList.remove("typing"), 500 + full.length * typing);
    }
    const start = 500 + full.length * typing;
    [...panel.querySelectorAll<HTMLElement>("[data-step]")].forEach((step, index) => {
      timeline([
        [start + index * 650, () => step.classList.replace("pending", "running")],
        [start + index * 650 + 480, () => step.classList.remove("running")],
      ]);
    });
  },
};

/* A pointer glides to Take over and presses it: the app is yours until you hand it back. */
const computer: Story = {
  play(panel) {
    const pointer = panel.querySelector<HTMLElement>(".pointer");
    const take = panel.querySelector<HTMLElement>("[data-take]");
    const active = row(panel, "active");
    if (!pointer || !take || !active) return;
    const box = panel.getBoundingClientRect();
    const place = (x: number, y: number) => {
      pointer.style.setProperty("--px", `${x}px`);
      pointer.style.setProperty("--py", `${y}px`);
    };
    place(box.width - 60, box.height + 10);
    timeline([
      [500, () => pointer.classList.add("shown")],
      [
        650,
        () => {
          const target = take.getBoundingClientRect();
          place(target.left - box.left + target.width / 2 - 4, target.top - box.top + 4);
        },
      ],
      [1900, () => pointer.classList.add("press")],
      [2050, () => replay(take, "pressed")],
      [2100, () => pointer.classList.remove("press")],
      [
        2300,
        () => {
          delete active.dataset.tone;
          const state = active.querySelector<HTMLElement>("[data-state]");
          if (state) {
            state.textContent = "You're in control";
            replay(state, "flip");
          }
          take.textContent = "Hand back";
          panel.querySelector<HTMLElement>("[data-stop]")?.remove();
        },
      ],
      [3400, () => pointer.classList.remove("shown")],
    ]);
  },
};

/* An agent asks for a device; the request is allowed and the device goes into use. */
const devices: Story = {
  prepare(panel) {
    row(panel, "ask")?.classList.add("folded");
  },
  play(panel) {
    const ask = row(panel, "ask");
    timeline([
      [900, () => ask?.classList.remove("folded")],
      [
        2400,
        () => {
          const allow = panel.querySelector("[data-allow]");
          if (allow) replay(allow, "pressed");
        },
      ],
      [2700, () => ask?.classList.add("folded")],
      [2900, () => setStatus(row(panel, "pixel"), "working", "Codex")],
    ]);
  },
};

/* Work crosses machines: lines draw from the Mac to what its agents use elsewhere, then to the
 * phone that approves. */
const fleet: Story = {
  play(panel) {
    const machines = [...panel.querySelectorAll<HTMLElement>(".machine")];
    const [mac, server, workstation] = machines;
    const phone = panel.querySelector<HTMLElement>(".phone");
    if (!mac || !server || !workstation || !phone) return;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("fleet-links");
    svg.setAttribute("aria-hidden", "true");
    panel.append(svg);

    const links: [HTMLElement, HTMLElement][] = [
      [mac, server],
      [mac, workstation],
      [server, phone],
    ];
    const paths = links.map(() => {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      svg.append(path);
      return path;
    });
    const draw = () => {
      links.forEach(([from, to], index) => {
        const path = paths[index];
        if (path) path.setAttribute("d", connect(panel, from, to));
      });
    };
    draw();
    new ResizeObserver(draw).observe(panel);
    for (const path of paths) path.style.setProperty("--length", String(path.getTotalLength()));

    paths.forEach((path, index) => {
      const at = 300 + index * 1200;
      timeline([
        [at, () => path.classList.add("drawn")],
        [at + 600, () => spark(panel, path.getAttribute("d") ?? "")],
      ]);
    });
    timeline([[300 + paths.length * 1200 + 300, () => replay(phone, "ring")]]);
  },
};

/** A curve from one panel's edge to another's, leaving sideways or downward as they sit. */
function connect(panel: HTMLElement, from: HTMLElement, to: HTMLElement): string {
  const box = panel.getBoundingClientRect();
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  const sideways = b.left >= a.right - 1;
  if (sideways) {
    const y = Math.min(a.bottom - 16, Math.max(a.top + 16, b.top + b.height / 2)) - box.top;
    const x1 = a.right - box.left;
    const x2 = b.left - box.left;
    const y2 = b.top + b.height / 2 - box.top;
    const mid = (x1 + x2) / 2;
    return `M ${x1} ${y} C ${mid} ${y}, ${mid} ${y2}, ${x2} ${y2}`;
  }
  const x1 = a.left + a.width / 2 - box.left;
  const y1 = a.bottom - box.top;
  const x2 = b.left + b.width / 2 - box.left;
  const y2 = b.top - box.top;
  const mid = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
}

/** A spark that travels a path once, then removes itself. */
function spark(panel: HTMLElement, d: string): void {
  if (!d) return;
  const dot = document.createElement("span");
  dot.className = "fleet-spark";
  dot.style.offsetPath = `path("${d}")`;
  dot.addEventListener("animationend", () => dot.remove());
  panel.append(dot);
}

/* One account hits its limit; the thread moves to another account and keeps working. */
const accounts: Story = {
  play(panel) {
    const thread = row(panel, "thread");
    const move = panel.querySelector<HTMLElement>("[data-move]");
    timeline([
      [1400, () => move && replay(move, "pressed")],
      [
        1700,
        () => {
          if (!thread) return;
          setStatus(thread, "working", "Moved to Claude · Work, working");
          move?.remove();
        },
      ],
    ]);
  },
};

/* An approval reaches the phone; it's answered there, and the thread goes back to work. */
const phone: Story = {
  play(panel) {
    const sheet = row(panel, "sheet");
    const approve = panel.querySelector<HTMLElement>("[data-approve]");
    timeline([
      [1600, () => approve && replay(approve, "pressed")],
      [1900, () => sheet?.classList.add("away")],
      [2300, () => setStatus(row(panel, "migrate"), "working", "Working")],
    ]);
  },
};

const stories: Record<string, Story> = {
  status,
  browser,
  computer,
  devices,
  fleet,
  accounts,
  phone,
};

/** Puts every panel on the page into its opening state. */
export function prepareStories(root: ParentNode): void {
  for (const panel of root.querySelectorAll<HTMLElement>("[data-story]")) {
    stories[panel.dataset.story ?? ""]?.prepare?.(panel);
  }
}

/** Plays the stories inside an element that has just come into view, each once. */
export function playStories(container: Element): void {
  const panels = [
    ...(container instanceof HTMLElement && container.dataset.story ? [container] : []),
    ...container.querySelectorAll<HTMLElement>("[data-story]"),
  ];
  for (const panel of panels) {
    if ("played" in panel.dataset) continue;
    panel.dataset.played = "";
    stories[panel.dataset.story ?? ""]?.play(panel);
  }
}
