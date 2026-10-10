import { Client, type ClientApi, type RequestOptions } from "@ace/client";
import { ClientProvider } from "@ace/client-react";
import { ClientHost, RemoteClient } from "@ace/client-worker";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, type ContextResult } from "@ace/protocol";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ImageUrl } from "./attachment-bytes.tsx";

const clients: Client[] = [];
const bridges: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:image");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((close) => close()));
  await Promise.all(clients.splice(0).map((client) => client.close()));
  vi.restoreAllMocks();
});

async function workerBridge(client: Client) {
  const scheduler = {
    set(delay: number, callback: () => void) {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    },
  };
  const host = new ClientHost({
    target: () => ({ key: "images", create: () => client }),
    scheduler,
    now: () => 1000,
    lingerMs: 0,
  });
  const { port1, port2 } = new MessageChannel();
  const left = Promise.withResolvers<void>();
  host.attach({
    postMessage: (message) => port1.postMessage(message),
    start: () => port1.start(),
    close: () => {
      port1.close();
      left.resolve();
    },
    addEventListener: (type, listener) => port1.addEventListener(type, listener),
    removeEventListener: (type, listener) => port1.removeEventListener(type, listener),
  });
  const remote = new RemoteClient(port2, {}, { scheduler });
  bridges.push(async () => {
    await remote.close();
    await left.promise;
  });
  await remote.start();
  return remote;
}

// The public UI and real client's ranged attachment assembly. Only the daemon read boundary
// is controlled: gates represent cold decoding and contention from other connections.
async function backend(capacity: number) {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  let id = 0;
  const client = new Client({
    deviceId: DeviceId.parse("images"),
    transport: () => fakeTransport(daemon),
    credential: async () => daemon.token,
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set: (delay, callback) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    random: () => 0.5,
    id: () => `image-${++id}`,
  });
  clients.push(client);
  const reads: { thread: string; hash: string; signal?: AbortSignal }[] = [];
  const finish: (() => void)[] = [];
  let active = 0;
  let busy = 0;
  const original = client.request.bind(client);
  vi.spyOn(client, "request").mockImplementation((input, options?: RequestOptions) => {
    if (input.type !== "context.request" || input.operation.op !== "attachment.read")
      return original(input, options);
    const op = input.operation;
    reads.push({
      thread: op.threadId,
      hash: op.sha256,
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    if (active >= capacity) {
      busy++;
      return Promise.resolve({
        type: "context.result",
        requestId: "read",
        result: { kind: "error", code: "busy", message: "Another connection is decoding" },
      } satisfies ContextResult);
    }
    active++;
    return new Promise<ContextResult>((resolve, reject) => {
      let settled = false;
      const settle = (aborted: boolean) => {
        if (settled) return;
        settled = true;
        active--;
        options?.signal?.removeEventListener("abort", abort);
        if (aborted) reject(new DOMException("Aborted", "AbortError"));
        else
          resolve({
            type: "context.result",
            requestId: "read",
            result: {
              kind: "attachment.data",
              sha256: op.sha256,
              variant: op.variant ?? "thumbnail",
              offset: op.offset ?? 0,
              mimeType: "image/png",
              bytes: 3,
              data: "AQID",
              eof: true,
            },
          });
      };
      const abort = () => settle(true);
      options?.signal?.addEventListener("abort", abort, { once: true });
      finish.push(() => settle(false));
    });
  });
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  return {
    client,
    reads,
    finish,
    busy: () => busy,
    active: () => active,
    admit: () => {
      capacity = 2;
    },
  };
}

function images(client: ClientApi, names: string[], thread = "thread", bytes = 3, full = false) {
  return (
    <ClientProvider client={client}>
      {names.map((name) => (
        <ImageUrl
          key={name}
          full={full}
          source={{
            kind: "attachment",
            threadId: thread,
            sha256: name.padStart(64, "0"),
            bytes,
            thumbnail: true,
          }}
        >
          {(image) =>
            image.state === "ready" ? (
              <img src={image.url} alt={name} />
            ) : (
              <span>
                {name}: {image.state}
              </span>
            )
          }
        </ImageUrl>
      ))}
    </ClientProvider>
  );
}

test("four cold images all become visible without overrunning the shared decoder", async () => {
  const f = await backend(2);
  render(images(f.client, ["a", "b", "c", "d"]));
  await waitFor(() => expect(f.active()).toBe(2));
  await act(async () => {
    f.finish.splice(0).forEach((finish) => finish());
  });
  await act(async () => {
    f.finish.splice(0).forEach((finish) => finish());
  });
  await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(4));
  expect(f.busy()).toBe(0);
});

test("a gallery larger than the socket's eight-request queue loads every image", async () => {
  const f = await backend(8);
  render(
    images(
      f.client,
      Array.from({ length: 12 }, (_, i) => i.toString(16)),
    ),
  );
  for (let batch = 0; batch < 6; batch++) {
    await waitFor(() => expect(f.active()).toBeGreaterThan(0));
    await act(async () => {
      f.finish.splice(0).forEach((finish) => finish());
    });
  }
  await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(12));
  expect(f.busy()).toBe(0);
});

test("temporary contention from another connection retries until the image is visible", async () => {
  const f = await backend(0);
  render(images(f.client, ["a"]));
  await waitFor(() => expect(f.busy()).toBe(1));
  f.admit();
  await waitFor(() => expect(f.active()).toBe(1));
  await act(async () => {
    f.finish.splice(0).forEach((finish) => finish());
  });
  expect(await screen.findByRole("img", { name: "a" })).toBeTruthy();
});

test("temporary busy and last-consumer cancellation survive the real worker bridge", async () => {
  const f = await backend(0);
  const remote = await workerBridge(f.client);
  const view = render(images(remote, ["a"]));
  await waitFor(() => expect(f.busy()).toBe(1));
  f.admit();
  await waitFor(() => expect(f.active()).toBe(1));
  await act(async () => {
    f.finish.splice(0).forEach((finish) => finish());
  });
  expect(await screen.findByRole("img", { name: "a" })).toBeTruthy();
  view.rerender(images(remote, ["b"]));
  await waitFor(() => expect(f.active()).toBe(1));
  view.unmount();
  await waitFor(() => expect(f.active()).toBe(0));
  expect(f.reads.at(-1)?.signal?.aborted).toBe(true);
});

test("persistent contention stops retrying and reports an unavailable image", async () => {
  const f = await backend(0);
  render(images(f.client, ["a"]));
  await screen.findByText("a: unavailable");
  expect(f.busy()).toBe(4);
});

test("two copies share a read until their last mounted consumer leaves", async () => {
  const f = await backend(2);
  const first = render(images(f.client, ["a"]));
  const second = render(images(f.client, ["a"]));
  await waitFor(() => expect(f.reads).toHaveLength(1));
  first.unmount();
  expect(f.reads[0]?.signal?.aborted).toBe(false);
  await act(async () => {
    f.finish.splice(0).forEach((finish) => finish());
  });
  expect(await screen.findByRole("img", { name: "a" })).toBeTruthy();
  second.unmount();
  render(images(f.client, ["a"]));
  expect(await screen.findByRole("img", { name: "a" })).toBeTruthy();
  expect(f.reads).toHaveLength(1);
});

test("unmount cancels active reads and removes queued reads without fetching their bytes", async () => {
  const f = await backend(2);
  const view = render(images(f.client, ["a", "b", "c", "d"]));
  await waitFor(() => expect(f.reads).toHaveLength(2));
  await act(async () => view.unmount());
  expect(f.reads.every((read) => read.signal?.aborted)).toBe(true);
  expect(f.reads).toHaveLength(2);
  // Canceled jobs do not leave a poisoned shared promise or populate the completed cache.
  render(images(f.client, ["a"]));
  await waitFor(() => expect(f.reads).toHaveLength(3));
  await act(async () => {
    f.finish.splice(0).forEach((finish) => finish());
  });
  expect(await screen.findByRole("img", { name: "a" })).toBeTruthy();
});

test("leaving an image during decoder contention cancels its delayed retry", async () => {
  const f = await backend(0);
  const view = render(images(f.client, ["a"]));
  await waitFor(() => expect(f.busy()).toBe(1));
  view.unmount();
  f.admit();
  render(images(f.client, ["b"]));
  await waitFor(() => expect(f.active()).toBe(1));
  await act(async () => {
    f.finish.splice(0).forEach((finish) => finish());
  });
  expect(await screen.findByRole("img", { name: "b" })).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(f.reads.map((read) => read.hash.slice(-1))).toEqual(["a", "b"]);
});

test("image reads are deduplicated only within their owning thread and connection", async () => {
  const first = await backend(2),
    second = await backend(2);
  render(images(first.client, ["a"], "thread-one"));
  render(images(first.client, ["a"], "thread-two"));
  render(images(second.client, ["a"], "thread-one"));
  await waitFor(() =>
    expect(first.reads.map((read) => read.thread)).toEqual(["thread-one", "thread-two"]),
  );
  await waitFor(() => expect(second.reads).toHaveLength(1));
  await act(async () => {
    [...first.finish, ...second.finish].forEach((finish) => finish());
  });
  await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(3));
});

test("switching the owning client clears its old ready URL while the same image loads", async () => {
  const first = await backend(2),
    second = await backend(2);
  const view = render(images(first.client, ["a"]));
  await waitFor(() => expect(first.active()).toBe(1));
  await act(async () => {
    first.finish.splice(0).forEach((finish) => finish());
  });
  expect(await screen.findByRole("img", { name: "a" })).toBeTruthy();
  view.rerender(images(second.client, ["a"]));
  await waitFor(() => expect(second.active()).toBe(1));
  expect(screen.queryByRole("img", { name: "a" })).toBeNull();
  expect(screen.getByText("a: loading")).toBeTruthy();
  await act(async () => {
    second.finish.splice(0).forEach((finish) => finish());
  });
  expect(await screen.findByRole("img", { name: "a" })).toBeTruthy();
});

test("large originals share a byte budget instead of allocating both full images at once", async () => {
  const f = await backend(2);
  render(images(f.client, ["a", "b"], "thread", 32 * 1024 * 1024, true));
  await waitFor(() => expect(f.reads).toHaveLength(1));
  await act(async () => {
    f.finish.splice(0).forEach((finish) => finish());
  });
  await waitFor(() => expect(f.reads).toHaveLength(2));
  await act(async () => {
    f.finish.splice(0).forEach((finish) => finish());
  });
  await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
});

test("an oversized gallery has bounded admission and unmount releases its waiting reads", async () => {
  const f = await backend(2);
  const view = render(
    images(
      f.client,
      Array.from({ length: 66 }, (_, i) => i.toString(16)),
    ),
  );
  expect(await screen.findAllByText(/unavailable/)).toHaveLength(2);
  await act(async () => view.unmount());
  expect(f.reads).toHaveLength(2);
  expect(f.active()).toBe(0);
});
