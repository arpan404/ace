import { describe, expect, test } from "vitest";
import { DeviceTabs } from "./device-tabs.ts";
import { FakeLoopbackHost, FakeTunnel, settle, type Serve } from "./device-tunnel-fixture.ts";
import { RecordingSink } from "./sheet-fixture.ts";

interface TabsPatch {
  tabs: {
    id: string;
    url: string;
    title: string;
    load: number;
    ready: boolean;
    problem: string | null;
  }[];
  holding: boolean;
  listening: number[];
  refused: string | null;
}

function machine(options: { ports?: number[]; serve?: Serve; host?: FakeLoopbackHost } = {}) {
  const sink = new RecordingSink();
  const host = options.host ?? new FakeLoopbackHost();
  const tunnels: FakeTunnel[] = [];
  let next = 0;
  const tabs = new DeviceTabs({
    sink,
    host,
    id: () => `tab-${++next}`,
    tunnel: () => {
      const tunnel = new FakeTunnel(options.ports ?? [], options.serve);
      tunnels.push(tunnel);
      return tunnel;
    },
  });
  const patch = () => sink.read("device.tabs") as TabsPatch | undefined;
  const open = async (address: string) => {
    tabs.handle({ kind: "open", address });
    const id = patch()?.tabs.at(-1)?.id ?? "";
    tabs.handle({ kind: "front", tabId: id });
    await settle();
    return id;
  };
  return { tabs, host, tunnels, patch, open };
}

const text = (bytes: Uint8Array[]) => new TextDecoder().decode(Buffer.concat(bytes));

describe("which ports a machine's device tabs take", () => {
  test("a device tab in front listens on the machine's ports and the page's own", async () => {
    const { host, patch, open } = machine({ ports: [5173, 4000] });
    await open("localhost:3000");
    expect(host.listening).toEqual([3000, 4000, 5173]);
    expect(patch()?.holding).toBe(true);
  });

  test("ports the machine opens later are listened on as they appear", async () => {
    const { host, tunnels, open } = machine({ ports: [3000] });
    await open("localhost:3000");
    tunnels[0]?.setPorts([3000, 8080]);
    await settle();
    expect(host.listening).toEqual([3000, 8080]);
  });

  test("navigating to another local port listens on it before discovery finds it", async () => {
    const { tabs, host, open } = machine();
    const id = await open("localhost:3000");
    tabs.handle({ kind: "page", tabId: id, url: "http://localhost:4100/callback" });
    await settle();
    expect(host.listening).toEqual([4100]);
  });

  test("closing the last device tab closes the listeners and the tunnel", async () => {
    const { tabs, host, tunnels, patch, open } = machine({ ports: [3000] });
    const id = await open("localhost:3000");
    tabs.handle({ kind: "close", tabId: id });
    await settle();
    expect(host.listening).toEqual([]);
    expect(tunnels[0]?.closed).toBe(true);
    expect(patch()?.tabs).toEqual([]);
  });

  test("another machine taking the ports stops this one asking for them", async () => {
    const { tabs, host, patch, open } = machine({ ports: [3000] });
    const id = await open("localhost:3000");
    const asked = host.asked.length;
    tabs.loopback.event("released", "", 0);
    await settle();
    expect(patch()?.holding).toBe(false);
    expect(host.asked.length).toBe(asked);
    tabs.handle({ kind: "front", tabId: id });
    await settle();
    expect(patch()?.holding).toBe(true);
    expect(host.listening).toEqual([3000]);
  });

  test("a port another app on the phone holds says so on its page", async () => {
    const host = new FakeLoopbackHost();
    host.busy.add(3000);
    const { patch, open } = machine({ host, ports: [3000, 4000] });
    await open("localhost:3000");
    expect(host.listening).toEqual([4000]);
    expect(patch()?.tabs[0]?.problem).toContain("Another app on this phone is using port 3000");
  });

  test("a localhost page waits to load until its port is listened on", async () => {
    const { tabs, patch } = machine();
    tabs.handle({ kind: "open", address: "localhost:3000" });
    const id = patch()?.tabs[0]?.id ?? "";
    expect(patch()?.tabs[0]?.ready).toBe(false);
    tabs.handle({ kind: "front", tabId: id });
    expect(patch()?.tabs[0]?.ready).toBe(false);
    await settle();
    expect(patch()?.tabs[0]?.ready).toBe(true);
  });

  test("a public page takes no port of its own", async () => {
    const { host, open } = machine();
    await open("example.com");
    expect(host.listening).toEqual([]);
  });

  test("an address typed for the shown tab loads there and takes its port", async () => {
    const { tabs, host, patch, open } = machine();
    const id = await open("example.com");
    tabs.handle({ kind: "navigate", tabId: id, address: "localhost:5173" });
    await settle();
    expect(patch()?.tabs[0]).toMatchObject({ url: "http://localhost:5173/", load: 2 });
    expect(host.listening).toEqual([5173]);
  });

  test("a page reporting where it went is not loaded again", async () => {
    const { tabs, patch, open } = machine();
    const id = await open("localhost:3000");
    tabs.handle({ kind: "page", tabId: id, url: "http://localhost:3000/next", title: "Next" });
    expect(patch()?.tabs[0]).toMatchObject({ title: "Next", load: 1 });
  });

  test("a load that failed before the page changed says why for its own port", async () => {
    const { tabs, host, patch, tunnels, open } = machine();
    const id = await open("example.com");
    tabs.handle({ kind: "navigate", tabId: id, address: "localhost:3000" });
    await settle();
    tunnels[0]?.refuse.set(3000, "tunnel_off");
    tabs.loopback.event("accept", "c1", 3000);
    // WebKit stays on the public page it came from, and says the load failed.
    tabs.handle({ kind: "page", tabId: id, url: "https://example.com/" });
    tabs.handle({ kind: "failed", tabId: id, url: "http://localhost:3000/" });
    await settle();
    expect(patch()?.tabs[0]?.problem).toContain("doesn't let devices open its localhost");
    expect(host.listening).toEqual([3000]);
    tabs.handle({ kind: "page", tabId: id, url: "https://example.org/" });
    expect(patch()?.tabs[0]?.problem).toBeNull();
  });

  test("typed text that isn't an address opens no tab", () => {
    const { tabs, patch } = machine();
    tabs.handle({ kind: "open", address: "two words" });
    expect(patch()?.refused).toBe("not_address");
    expect(patch()?.tabs).toEqual([]);
  });
});

describe("a page's connection to the machine", () => {
  test("bytes go both ways, paced by the tunnel and the phone's socket", async () => {
    const { tabs, host, tunnels, open } = machine({
      serve: (side) => side.answer(new TextEncoder().encode("HTTP/1.1 200 OK\r\n\r\nhi")),
    });
    await open("localhost:3000");
    tabs.loopback.event("accept", "c1", 3000);
    await settle();
    expect(host.of("c1", "read")).toHaveLength(1);
    expect(text(host.of("c1", "write").map((entry) => entry.bytes ?? new Uint8Array()))).toBe(
      "HTTP/1.1 200 OK\r\n\r\nhi",
    );

    tabs.loopback.event("data", "c1", new TextEncoder().encode("GET / HTTP/1.1\r\n\r\n"));
    await settle();
    const side = tunnels[0]?.sides[0];
    expect(text(side?.received ?? [])).toBe("GET / HTTP/1.1\r\n\r\n");
    // The next chunk is asked for only once the tunnel admitted this one.
    expect(host.of("c1", "read")).toHaveLength(2);
  });

  test("the machine's next chunk waits until the phone sent the last", async () => {
    let answer: ((bytes: Uint8Array) => void) | undefined;
    const { tabs, host, open } = machine({ serve: (side) => (answer = side.answer) });
    await open("localhost:3000");
    tabs.loopback.event("accept", "c1", 3000);
    await settle();
    answer?.(new Uint8Array([1]));
    answer?.(new Uint8Array([2]));
    await settle();
    expect(host.of("c1", "write")).toHaveLength(1);
    tabs.loopback.event("written", "c1", 0);
    await settle();
    expect(host.of("c1", "write")).toHaveLength(2);
  });

  test("half-closes pass through, and a finished connection is forgotten", async () => {
    const { tabs, host, tunnels, open } = machine();
    host.autoWritten = (connection) =>
      queueMicrotask(() => tabs.loopback.event("written", connection, 0));
    await open("localhost:3000");
    tabs.loopback.event("accept", "c1", 3000);
    await settle();
    tabs.loopback.event("end", "c1", 0);
    const side = tunnels[0]?.sides[0];
    expect(side?.ended).toBe(true);
    side?.answer(new Uint8Array([7]));
    side?.finish();
    await settle();
    expect(host.of("c1", "end")).toHaveLength(1);
    expect(tabs.loopback.open).toBe(0);
  });

  test("a stream reset before any answer says nothing runs on that port", async () => {
    const { tabs, host, patch, open } = machine({ serve: (side) => side.reset() });
    await open("localhost:3000");
    tabs.loopback.event("accept", "c1", 3000);
    await settle();
    expect(host.of("c1", "reset")).toHaveLength(1);
    expect(patch()?.tabs[0]?.problem).toBe("Nothing is running on port 3000 on the machine.");
  });

  test("a later answer on the port clears the problem", async () => {
    let listening = false;
    const { tabs, patch, open } = machine({
      serve: (side) => (listening ? side.answer(new Uint8Array([1])) : side.reset()),
    });
    await open("localhost:3000");
    tabs.loopback.event("accept", "c1", 3000);
    await settle();
    listening = true;
    tabs.loopback.event("accept", "c2", 3000);
    await settle();
    expect(patch()?.tabs[0]?.problem).toBeNull();
  });

  test.each([
    ["tunnel_off", "doesn't let devices open its localhost"],
    ["tunnel_forbidden", "can only watch this machine"],
    ["tunnel_port_refused", "Port 3000 belongs to ace"],
    ["tunnel_limit", "Too many connections"],
    ["offline", "can't be reached"],
  ])("a %s refusal resets the connection and says why", async (code, words) => {
    const { tabs, host, tunnels, patch, open } = machine();
    await open("localhost:3000");
    tunnels[0]?.refuse.set(3000, code);
    tabs.loopback.event("accept", "c1", 3000);
    await settle();
    expect(host.of("c1", "reset")).toHaveLength(1);
    expect(patch()?.tabs[0]?.problem).toContain(words);
  });

  test("the page closing its connection resets the machine's stream", async () => {
    const { tabs, tunnels, open } = machine();
    await open("localhost:3000");
    tabs.loopback.event("accept", "c1", 3000);
    await settle();
    const side = tunnels[0]?.sides[0];
    let reset = false;
    const original = side?.reset;
    if (side && original)
      side.reset = () => {
        reset = true;
        original();
      };
    tabs.loopback.event("reset", "c1", 0);
    await settle();
    expect(reset).toBe(true);
    expect(tabs.loopback.open).toBe(0);
  });
});
