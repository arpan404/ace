import { ClientProvider } from "@ace/client-react";
import { FakeDaemon } from "@ace/fake-daemon";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { LayoutProvider } from "@/lib/layout.tsx";
import { fakeClient } from "@/test/fake-client.ts";
import { panelServices, usePanelServices } from "./services.ts";
import { WithServices } from "./with-services.tsx";

function Loaded() {
  const services = usePanelServices();
  return <output>{services.viewed.get().size}</output>;
}

test("a failed panel code load shows recovery and a later load publishes shared services to mounted panels", async () => {
  const client = fakeClient(new FakeDaemon({ clock: () => 1000 }));
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  const chunk = Promise.withResolvers<never>();
  const first = panelServices(client, () => chunk.promise);
  const view = render(
    <ClientProvider client={client}>
      <LayoutProvider>
        <WithServices>
          <Loaded />
        </WithServices>
        <WithServices>
          <Loaded />
        </WithServices>
      </LayoutProvider>
    </ClientProvider>,
  );
  await act(async () => {
    chunk.reject(new Error("Chunk fetch failed"));
    await expect(first).rejects.toThrow("Chunk fetch failed");
  });
  expect(await screen.findAllByRole("alert")).toHaveLength(2);
  expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
  const retry = screen.getAllByRole("button", { name: "Try again" })[0];
  if (!retry) throw new Error("Missing panel retry");
  fireEvent.click(retry);
  await waitFor(() => expect(screen.getAllByText("0")).toHaveLength(2));
  const shared = await panelServices(client);
  const second = await panelServices(client);
  shared.viewed.set(() => new Map([["thread", new Map([["a.ts", "v1"]])]]));
  expect(second.viewed.get().size).toBe(1);
  view.unmount();
});
