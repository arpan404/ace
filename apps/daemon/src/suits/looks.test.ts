import { expect, it } from "vitest";
import { ThreadId } from "@ace/protocol";
import type { SuitActive, SuitLiveCheck } from "@ace/protocol/suits";
import { SuitLooks, type LookSocket } from "./looks.ts";

const mine = ThreadId.parse("thread-mine");
const theirs = ThreadId.parse("thread-theirs");

/** A socket of `device` that may read `threads`, recording what it hears. */
function socket(device: string, threads: readonly ThreadId[]) {
  const heard: SuitActive[] = [];
  const checks: SuitLiveCheck[] = [];
  const looks: LookSocket = {
    device,
    hears: (thread) => threads.includes(thread),
    send: (active) => heard.push(active),
    check: (check) => checks.push(check),
  };
  return { looks, heard, checks };
}

function hub() {
  let next = 0;
  return new SuitLooks(() => `keep-${++next}`);
}

it("a preview reaches only sockets that may read the calling thread, and later ones too", () => {
  const looks = hub();
  const laptop = socket("laptop", [mine]);
  const stranger = socket("stranger", [theirs]);
  looks.attach(laptop.looks);
  looks.attach(stranger.looks);

  looks.preview(mine, "starfield");
  const phone = socket("phone", [mine]);
  looks.attach(phone.looks);

  expect(laptop.heard).toEqual([{ kind: "none" }, { kind: "preview", suitId: "starfield" }]);
  expect(phone.heard).toEqual([{ kind: "preview", suitId: "starfield" }]);
  expect(stranger.heard).toEqual([{ kind: "none" }]);
});

it("ending a preview sends back the device's own look, and another thread can't end it", () => {
  const looks = hub();
  const laptop = socket("laptop", [mine, theirs]);
  looks.attach(laptop.looks);
  looks.preview(mine, "starfield");

  looks.preview(theirs, null);
  expect(laptop.heard.at(-1)).toEqual({ kind: "preview", suitId: "starfield" });
  looks.preview(mine, null);
  expect(laptop.heard.at(-1)).toEqual({ kind: "none" });
});

it("a keep changes only the devices that saw the preview, and its undo goes to the same ones", () => {
  const looks = hub();
  const laptop = socket("laptop", [mine]);
  looks.attach(laptop.looks);
  looks.preview(mine, "warm-paper");
  // A device that connects after the preview ended never saw it.
  const kept = looks.keep(mine, "warm-paper");
  const desktop = socket("desktop", [mine]);
  looks.attach(desktop.looks);
  kept.restore();

  expect(laptop.heard.slice(-2)).toEqual([
    { kind: "keep", suitId: "warm-paper", keepId: "keep-1" },
    { kind: "restore", keepId: "keep-1" },
  ]);
  expect(desktop.heard).toEqual([{ kind: "none" }]);
});

it("a device that saw the preview but was offline at the keep hears it when it reconnects", () => {
  const looks = hub();
  const phone = socket("phone", [mine]);
  const detach = looks.attach(phone.looks);
  looks.preview(mine, "starfield");
  detach();
  looks.keep(mine, "starfield");

  const again = socket("phone", [mine]);
  looks.attach(again.looks);
  expect(again.heard).toEqual([
    { kind: "none" },
    { kind: "keep", suitId: "starfield", keepId: "keep-1" },
  ]);
});

it("a newer preview from another thread takes over, and devices it doesn't reach go back", () => {
  const looks = hub();
  const both = socket("laptop", [mine, theirs]);
  const onlyMine = socket("phone", [mine]);
  looks.attach(both.looks);
  looks.attach(onlyMine.looks);
  looks.preview(mine, "warm-paper");

  looks.preview(theirs, "starfield");
  expect(both.heard.at(-1)).toEqual({ kind: "preview", suitId: "starfield" });
  expect(onlyMine.heard.at(-1)).toEqual({ kind: "none" });
});

it("a live check is asked only of the sockets that may read the calling thread", () => {
  const looks = hub();
  const laptop = socket("laptop", [mine]);
  const stranger = socket("stranger", [theirs]);
  looks.attach(laptop.looks);
  looks.attach(stranger.looks);
  const asked = looks.askCheck(mine, { checkId: "check-1", suitId: "neon-district" });
  expect(asked).toEqual([laptop.looks]);
  expect(laptop.checks).toEqual([{ checkId: "check-1", suitId: "neon-district" }]);
  expect(stranger.checks).toEqual([]);
});
