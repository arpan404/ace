import type { ShotId } from "../scripts/zoom-camera.ts";
import { product } from "./product.ts";
import { machines } from "./stage.ts";

/*
 * The home page's opening story: one prompt in ace's composer, then the camera pulls back to
 * show the thread it became, the app around it, the machines it reached and the phone it
 * calls (components/zoom/ZoomStory.astro). The thread and its agents are the ones the drawn
 * window already shows (content/stage.ts); only the captions live here.
 */

/** The headline, a sentence to a line. */
export const zoomHeadline: string[] = product.headline
  .match(/[^.]+\./g)
  ?.map((line) => line.trim()) ?? [product.headline];

export interface ZoomCaption {
  /** The shot this caption is read on. */
  shot: Exclude<ShotId, "prompt">;
  title: string;
  body: string;
  /** The page that tells more. */
  href: string;
}

export const zoomCaptions: ZoomCaption[] = [
  {
    shot: "thread",
    title: "It splits the work.",
    body: "Claude fixes the server and hands off the rest: Codex writes the test, Cursor reviews the change, and the soak test goes to your Linux server.",
    href: "/features/orchestration/",
  },
  {
    shot: "app",
    title: "Your other tasks keep going.",
    body: "Every task has its own thread and, if you like, its own git worktree. Each row shows what it is doing right now, and the one that needs you stands out.",
    href: "/features/status/",
  },
  {
    shot: "fleet",
    title: "Every machine works at once.",
    body: "The soak test runs on the build server while your Mac keeps going. Threads from every machine share one list, wherever you open ace.",
    href: "/features/fleet/",
  },
  {
    shot: "phone",
    title: "It calls you only when the decision is yours.",
    body: "Step away. An approval arrives on your Lock Screen, and the thread carries on once you answer.",
    href: "/features/mobile/",
  },
  {
    shot: "all",
    title: "Done means everyone is done.",
    body: "A thread shows as done only when every agent and command under it has finished.",
    href: "/features/status/",
  },
];

const machine = (id: (typeof machines)[number]["id"]) => {
  const found = machines.find((entry) => entry.id === id);
  if (!found) throw new Error(`No machine ${id} in stage.ts`);
  return found;
};

/** What stands in the picture besides ace's window, as its label names it. */
export const zoomCast = {
  mac: { name: machine("this-mac").name, note: machine("this-mac").note },
  build: { name: machine("build-server").name, note: machine("build-server").note },
  workstation: { name: machine("workstation").name, note: machine("workstation").note },
  phone: { name: "Your iPhone", note: "" },
} as const;

export type CastId = keyof typeof zoomCast;

/** The lines between them, each with the verb it carries. */
export const zoomLinks: { from: CastId; to: CastId; verb: string }[] = [
  { from: "mac", to: "build", verb: "hands off" },
  { from: "mac", to: "workstation", verb: "uses its browser" },
  { from: "mac", to: "phone", verb: "asks you" },
];
