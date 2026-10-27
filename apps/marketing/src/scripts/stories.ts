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
 * phone that approves. Each line ends in a port on the card it reaches. */
const fleet: Story = {
  play(panel) {
    const [mac, server, workstation] = [...panel.querySelectorAll<HTMLElement>(".machine")];
    const phone = panel.querySelector<HTMLElement>(".phone");
    if (!mac || !server || !workstation || !phone) return;
    const svgNs = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNs, "svg");
    svg.classList.add("fleet-links");
    svg.setAttribute("aria-hidden", "true");
    panel.append(svg);

    const links: [HTMLElement, HTMLElement][] = [
      [mac, server],
      [mac, workstation],
      [server, phone],
    ];
    const lines = links.map(() => {
      const group = document.createElementNS(svgNs, "g");
      const path = document.createElementNS(svgNs, "path");
      const ports = [0, 1].map(() => {
        const port = document.createElementNS(svgNs, "circle");
        port.setAttribute("r", "3");
        return port;
      });
      group.append(path, ...ports);
      svg.append(group);
      return { group, path, ports };
    });
    const draw = () => {
      links.forEach(([from, to], index) => {
        const line = lines[index];
        if (!line) return;
        const { d, ends } = connect(panel, from, to);
        line.path.setAttribute("d", d);
        ends.forEach(([x, y], end) => {
          line.ports[end]?.setAttribute("cx", String(x));
          line.ports[end]?.setAttribute("cy", String(y));
        });
        line.path.style.setProperty("--length", String(line.path.getTotalLength()));
      });
    };
    draw();
    new ResizeObserver(draw).observe(panel);

    lines.forEach((line, index) => {
      const at = 300 + index * 1100;
      timeline([
        [at, () => line.group.classList.add("drawn")],
        [at + 550, () => spark(panel, line.path.getAttribute("d") ?? "")],
      ]);
    });
    timeline([[300 + lines.length * 1100 + 300, () => replay(phone, "ring")]]);
  },
};

/** An element's box in `root`'s own layout, unaffected by transforms mid-animation. */
function layoutBox(element: HTMLElement, root: HTMLElement) {
  let left = 0;
  let top = 0;
  for (let at: HTMLElement | null = element; at && at !== root;) {
    left += at.offsetLeft;
    top += at.offsetTop;
    at = at.offsetParent instanceof HTMLElement ? at.offsetParent : null;
  }
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  return { left, top, right: left + width, bottom: top + height, width, height };
}

/**
 * A curve from one card's edge to another's: sideways when the second sits to the right,
 * otherwise straight down. Returns the path and its two end points, for the ports.
 */
function connect(
  panel: HTMLElement,
  from: HTMLElement,
  to: HTMLElement,
): { d: string; ends: [number, number][] } {
  const a = layoutBox(from, panel);
  const b = layoutBox(to, panel);
  if (b.left >= a.right - 1) {
    const y1 = a.top + Math.min(a.height - 20, 58);
    const y2 = b.top + Math.min(b.height - 20, 58);
    const mid = (a.right + b.left) / 2;
    return {
      d: `M ${a.right} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${b.left} ${y2}`,
      ends: [
        [a.right, y1],
        [b.left, y2],
      ],
    };
  }
  const x1 = a.left + a.width / 2;
  const x2 = b.left + b.width / 2;
  const mid = (a.bottom + b.top) / 2;
  return {
    d: `M ${x1} ${a.bottom} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${b.top}`,
    ends: [
      [x1, a.bottom],
      [x2, b.top],
    ],
  };
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
