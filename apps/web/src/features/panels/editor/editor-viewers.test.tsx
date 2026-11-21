import { coldStartReplay } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

/*
 * Files the editor doesn't edit as text still open in the editor's tabs, read only: rendered
 * Markdown (with Source beside it), pictures, PDFs, players, and a line with Download for a
 * binary file. Same tab rules as source: a glance is a preview, Enter keeps it.
 */

configure({ asyncUtilTimeout: 10000 });

const thread = "thread-cold-start";

async function openThread() {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open(`/t/${thread}`);
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  return app;
}

const panel = () => screen.findByRole("region", { name: "Thread panel" });

async function open(text: string) {
  await userEvent.keyboard("{Control>}p{/Control}");
  await userEvent.type(await screen.findByRole("combobox", { name: "Search files" }), text);
  await screen.findByRole("option", { name: new RegExp(text.replace(".", "\\.")) });
  await userEvent.keyboard("{Enter}");
  return panel();
}

/** jsdom has no object URLs: stub them at that boundary, remembering each one's blob. */
function objectUrls() {
  const blobs = new Map<string, Blob>();
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => {
    const url = `blob:test/${blobs.size + 1}`;
    if (blob instanceof Blob) blobs.set(url, blob);
    return url;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  return blobs;
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("markdown opens rendered in an editor tab, Source shows its lines, and the tab keeps the choice", async () => {
  await openThread();
  const side = await open("README");
  expect(await within(side).findByRole("tab", { name: "README.md", selected: true })).toBeTruthy();
  expect(await within(side).findByRole("heading", { name: "relay" })).toBeTruthy();
  await userEvent.click(within(side).getByRole("button", { name: "Source" }));
  const source = await within(side).findByRole("region", { name: "Source of README.md" });
  await waitFor(() => expect(source.textContent).toContain("# relay"));

  // Away to another file and back: README is still shown as source.
  await open("socket");
  await within(side).findByRole("region", { name: "Source of apps/web/src/relay/socket.ts" });
  await userEvent.click(within(side).getByRole("tab", { name: "README.md" }));
  expect(await within(side).findByRole("region", { name: "Source of README.md" })).toBeTruthy();
  await userEvent.click(within(side).getByRole("button", { name: "Preview" }));
  expect(await within(side).findByRole("heading", { name: "relay" })).toBeTruthy();
  expect(within(side).queryByRole("region", { name: "Source of README.md" })).toBeNull();
});

test("a binary file opens in an editor tab that says so and offers a download", async () => {
  await openThread();
  const side = await open("inter.woff2");
  expect(
    await within(side).findByRole("tab", { name: "inter.woff2", selected: true }),
  ).toBeTruthy();
  expect(await within(side).findByText("Binary file")).toBeTruthy();
  expect(within(side).getByRole("button", { name: "Download" })).toBeTruthy();
});

test("a checkout PDF opens in the browser's PDF viewer and a video plays in editor tabs", async () => {
  const blobs = objectUrls();
  const app = await openThread();
  app.daemon.checkouts.seed(thread, "docs/spec.pdf", "%PDF-1.7 spec");
  app.daemon.checkouts.seed(thread, "docs/tour.mp4", "mp4 bytes");

  const side = await open("spec.pdf");
  const frame = await within(side).findByTitle("spec.pdf");
  expect(frame.tagName).toBe("IFRAME");
  const pdf = blobs.get(frame.getAttribute("src") ?? "");
  expect(pdf?.type).toBe("application/pdf");
  expect(await pdf?.text()).toBe("%PDF-1.7 spec");

  await open("tour.mp4");
  const video = await within(side).findByLabelText("tour.mp4", { selector: "video" });
  expect(video.hasAttribute("controls")).toBe(true);
  expect(await blobs.get(video.getAttribute("src") ?? "")?.text()).toBe("mp4 bytes");
  // Both stay open as tabs of the one group.
  expect(within(side).getByRole("tab", { name: "spec.pdf" })).toBeTruthy();
});

test("a checkout screenshot over 2 MB opens whole as a picture in an editor tab", async () => {
  const blobs = objectUrls();
  const app = await openThread();
  const png = new Uint8Array(3 * 1024 * 1024);
  png.set([137, 80, 78, 71, 13, 10, 26, 10]);
  png[png.length - 1] = 0x42;
  app.daemon.checkouts.seedBytes(thread, "docs/shot.png", png);

  const side = await open("shot.png");
  const image = await within(side).findByRole("img", { name: "shot.png" });
  const blob = blobs.get(image.getAttribute("src") ?? "");
  expect(blob?.type).toBe("image/png");
  expect(blob?.size).toBe(png.length);
  expect(within(side).queryByText(/too large/i)).toBeNull();
});

test("a text file of a type ace doesn't know opens as editable source", async () => {
  const app = await openThread();
  app.daemon.checkouts.seed(thread, "deploy/release.plan", "stage one\nstage two\n");
  const side = await open("release.plan");
  const source = await within(side).findByRole("region", { name: "Source of deploy/release.plan" });
  await waitFor(() => expect(source.textContent).toContain("stage two"));
  expect(within(side).queryByText("Binary file")).toBeNull();
});
