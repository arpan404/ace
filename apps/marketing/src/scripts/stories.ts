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
  browser,
  devices,
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
