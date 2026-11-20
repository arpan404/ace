import { expect, test } from "vitest";
import {
  openMachineTunnel,
  tunnelRetryMs,
  type TunnelLink,
  type TunnelPath,
} from "./machine-tunnel.ts";
import type { ChannelEvents } from "./device-transport.ts";

/*
 * When the device's tunnel connects again after a drop: links that stand in for each path's
 * connection, and a clock the test runs by hand.
 */

function harness() {
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
  const links: { events: ChannelEvents | undefined; closed: boolean }[] = [];
  const path: TunnelPath = {
    key: "lan",
    link(): TunnelLink {
      const made: (typeof links)[number] = { events: undefined, closed: false };
      links.push(made);
      return {
        open(events) {
          made.events = events;
        },
        sendBinary: async () => {},
        close() {
          made.closed = true;
        },
      };
    },
  };
  const tunnel = openMachineTunnel({
    path: { get: () => path, subscribe: () => () => {} },
    schedule(run, ms) {
      const timer = { run, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  const latest = () => {
    const link = links.at(-1);
    if (!link?.events) throw new Error("No link open");
    return link.events;
  };
  /** The reconnect delays scheduled so far, in order. */
  const retries = () =>
    timers.filter((timer) => tunnelRetryMs.some((ms) => ms === timer.ms)).map((t) => t.ms);
  /** Runs the newest pending reconnect. */
  const fire = () => {
    const timer = timers.findLast((each) => !each.cancelled);
    if (!timer) throw new Error("Nothing scheduled");
    timer.cancelled = true;
    timer.run();
  };
  return { tunnel, links, latest, retries, fire };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

test("opens during the backoff wait for its scheduled attempt and share it", async () => {
  const { tunnel, links, latest, fire } = harness();
  // The first connection drops before the machine answers.
  latest().close();
  const opens = [tunnel.open(3000), tunnel.open(3001), tunnel.open(3002)];
  for (const open of opens) open.catch(() => {});
  await settle();
  expect(links).toHaveLength(1);
  fire();
  await settle();
  // One new connection for every open waiting, made when the backoff said.
  expect(links).toHaveLength(2);
  latest().close();
  for (const open of opens) await expect(open).rejects.toMatchObject({ code: "offline" });
  expect(links).toHaveLength(2);
});

test("the backoff grows across welcomes that end in a refusal or a drop, until the tunnel is accepted", async () => {
  const { latest, retries, fire } = harness();
  for (let n = 0; n < 3; n++) {
    latest().ready();
    latest().close();
    fire();
  }
  expect(retries()).toEqual([tunnelRetryMs[0], tunnelRetryMs[1], tunnelRetryMs[2]]);
  // Accepted: the machine sent its ports. The next drop starts over.
  latest().ready();
  await latest().message({ type: "tunnel.ports", ports: [3000] });
  latest().close();
  expect(retries().at(-1)).toBe(tunnelRetryMs[0]);
});

test("an open under way when the machine refuses the tunnel reports the refusal, not a drop", async () => {
  const { tunnel, latest } = harness();
  const events = latest();
  events.ready();
  await events.message({ type: "tunnel.refused", code: "tunnel_off" });
  const open = tunnel.open(3000);
  events.close();
  await expect(open).rejects.toMatchObject({ code: "tunnel_off" });
  await expect(tunnel.open(3000)).rejects.toMatchObject({ code: "tunnel_off" });
});

test("an open given up during the backoff rejects at once, and the others still get the attempt", async () => {
  const { tunnel, links, latest, fire } = harness();
  latest().close();
  const controller = new AbortController();
  let outcome = "pending";
  const given = tunnel.open(3000, { signal: controller.signal });
  given.catch((error: { code?: string }) => {
    outcome = error.code ?? "error";
  });
  const other = tunnel.open(3001);
  other.catch(() => {});
  await settle();
  controller.abort();
  await settle();
  // Before the scheduled attempt has run.
  expect(outcome).toBe("tunnel_cancelled");
  fire();
  await settle();
  expect(links).toHaveLength(2);
  latest().close();
  await expect(other).rejects.toMatchObject({ code: "offline" });
});
