import { facts, workbench, type Scenario } from "@ace/fake-daemon";
import type { ClientApi } from "@ace/client";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { fakeClient, harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const { endTurn, message, rootAgent, turn } = facts;

/** A finished thread "Fix the footer" in project `docs`, so the sidebar shows its badge. */
function docs(): Scenario {
  return {
    thread: { id: "thread-docs", workspaceId: "docs", title: "Fix the footer", provider: "claude" },
    steps: [
      {
        kind: "facts",
        facts: [
          rootAgent("claude", "/home/dev/docs"),
          turn("root"),
          message("root", "ask", "user", "Go"),
          endTurn("root"),
        ],
      },
    ],
  };
}

function app() {
  const made = harness();
  made.daemon.projects.seedFolders("/home/dev", [{ path: "/home/dev/site", git: true }]);
  made.play(docs()).runUntilBlocked();
  return made;
}

async function ready(client: ClientApi) {
  await client.start();
  await vi.waitFor(() => expect(client.state).toBe("ready"));
}

const saved = (made: ReturnType<typeof harness>, id = "docs") =>
  made.daemon.projects.list().workspaces.find((project) => project.id === id);

/** The badge drawn in an element: its image, or its tile's tint, glyph and letters. */
function badgeIn(element: HTMLElement) {
  const image = element.querySelector("img");
  const tile = element.querySelector<HTMLElement>("[data-project-mark]");
  return {
    image: image?.getAttribute("src") ?? undefined,
    tint: tile?.style.getPropertyValue("--tint"),
    glyph: tile?.querySelector("svg") !== null && tile !== null,
    letters: tile?.textContent ?? "",
  };
}

const sidebarBadge = () =>
  badgeIn(
    within(screen.getByRole("navigation", { name: "Threads" })).getByRole("link", {
      name: /Fix the footer/,
    }),
  );
/** The badge beside docs in the New thread project picker. */
async function pickerBadge() {
  await userEvent.click(screen.getByRole("button", { name: "Project: docs" }));
  const picker = await screen.findByRole("dialog", { name: "Choose project" });
  const badge = badgeIn(await within(picker).findByRole("option", { name: "docs" }));
  await userEvent.keyboard("{Escape}");
  return badge;
}

async function openEditor() {
  await userEvent.click(await screen.findByRole("button", { name: /^Project filter:/ }));
  await userEvent.pointer({
    keys: "[MouseRight]",
    target: await screen.findByRole("menuitemradio", { name: "docs" }),
  });
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit project…" }));
  return screen.findByRole("dialog", { name: "Edit project" });
}

async function save(dialog: HTMLElement) {
  await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit project" })).toBeNull());
}

test("initials in a chosen colour become the project's badge in the sidebar and the picker", async () => {
  const made = app();
  await made.open("/new?project=docs");
  await screen.findByRole("button", { name: "Project: docs" });
  await waitFor(() => expect(sidebarBadge().letters).toBe("DO"));
  const before = sidebarBadge().tint;

  const dialog = await openEditor();
  await userEvent.click(within(dialog).getByRole("button", { name: "Initials" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Blue" }));
  await save(dialog);

  await waitFor(() => expect(sidebarBadge().tint).toBe("var(--project-8)"));
  expect(before).not.toBe("var(--project-8)");
  expect(sidebarBadge().letters).toBe("DO");
  expect(await pickerBadge()).toMatchObject({ tint: "var(--project-8)", letters: "DO" });
  expect(saved(made)?.badge).toEqual({ color: "blue" });
});

test("a curated icon in a colour replaces the initials everywhere and on other devices", async () => {
  const made = app();
  const other = fakeClient(made.daemon);
  await ready(other);
  await made.open("/new?project=docs");
  await screen.findByRole("button", { name: "Project: docs" });

  const dialog = await openEditor();
  await userEvent.click(within(dialog).getByRole("button", { name: "Icon" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Rocket" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Green" }));
  // The preview is the sidebar's own badge before anything is saved.
  expect(badgeIn(within(dialog).getByRole("img", { name: "Icon preview" }))).toMatchObject({
    glyph: true,
    tint: "var(--project-5)",
  });
  await save(dialog);

  await waitFor(() => expect(sidebarBadge()).toMatchObject({ glyph: true, letters: "" }));
  expect(sidebarBadge().tint).toBe("var(--project-5)");
  expect(await pickerBadge()).toMatchObject({ glyph: true, tint: "var(--project-5)" });
  const listed = await other.request({
    type: "workspace.request",
    operation: { op: "workspaces.list", limit: 100 },
  });
  const result = listed.result;
  expect(
    result.kind === "workspaces" && result.workspaces.find((p) => p.id === "docs"),
  ).toMatchObject({ badge: { glyph: "rocket", color: "green" } });
});

/** A real PNG signature, as a picked file's first bytes and as the scaled badge's data URL. */
const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52];
const scaled = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

/** The browser's image decoding and canvas, which jsdom doesn't have. */
function browserImages() {
  const drawn: number[][] = [];
  vi.stubGlobal("createImageBitmap", async () => ({ width: 300, height: 200, close() {} }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    const context = {
      imageSmoothingQuality: "low",
      drawImage: (...args: unknown[]) => drawn.push(args.slice(1).map(Number)),
    };
    return context as unknown as CanvasRenderingContext2D;
  });
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(scaled);
  return drawn;
}

test("an uploaded image is cropped square and becomes the badge in the sidebar and the picker", async () => {
  const drawn = browserImages();
  const made = app();
  await made.open("/new?project=docs");
  await screen.findByRole("button", { name: "Project: docs" });

  const dialog = await openEditor();
  await userEvent.click(within(dialog).getByRole("button", { name: "Image" }));
  await userEvent.upload(
    within(dialog).getByLabelText("Project image"),
    new File([new Uint8Array(png)], "logo.png", { type: "image/png" }),
  );
  await waitFor(() =>
    expect(badgeIn(within(dialog).getByRole("img", { name: "Icon preview" })).image).toBe(scaled),
  );
  // The centred 200 × 200 square of a 300 × 200 picture, scaled to 128 px.
  expect(drawn).toEqual([[50, 0, 200, 200, 0, 0, 128, 128]]);
  await save(dialog);

  await waitFor(() => expect(sidebarBadge().image).toBe(scaled));
  expect((await pickerBadge()).image).toBe(scaled);
  expect(saved(made)).toMatchObject({ icon: scaled });
  expect(saved(made)?.badge).toBeUndefined();
});

test("a file that isn't an accepted image is refused with a clear message and nothing changes", async () => {
  browserImages();
  const made = app();
  await made.open("/new?project=docs");
  await screen.findByRole("button", { name: "Project: docs" });
  const user = userEvent.setup({ applyAccept: false });

  const dialog = await openEditor();
  await user.click(within(dialog).getByRole("button", { name: "Image" }));
  const input = within(dialog).getByLabelText("Project image");
  await user.upload(input, new File(["hello"], "notes.txt", { type: "text/plain" }));
  expect((await within(dialog).findByRole("alert")).textContent).toBe(
    "Use a PNG, JPEG, WebP or GIF image.",
  );
  await user.upload(input, new File(["<script>"], "logo.png", { type: "image/png" }));
  await waitFor(() =>
    expect(within(dialog).getByRole("alert").textContent).toBe(
      "That file isn't a PNG, JPEG, WebP or GIF image.",
    ),
  );
  await user.upload(
    input,
    new File([new Uint8Array(6 * 1024 * 1024)], "huge.png", { type: "image/png" }),
  );
  await waitFor(() =>
    expect(within(dialog).getByRole("alert").textContent).toBe(
      "That image is over 5 MB. Pick a smaller one.",
    ),
  );
  await save(dialog);

  expect(saved(made)?.icon).toBeUndefined();
  await waitFor(() => expect(sidebarBadge()).toMatchObject({ image: undefined, letters: "DO" }));
});

test("a project's defaults start its new threads with its model, checkout and base branch", async () => {
  const made = harness();
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  const other = fakeClient(made.daemon);
  await ready(other);
  const relay = made.daemon.projects.list().workspaces.find((project) => project.id === "relay");
  if (!relay) throw new Error("the workbench lists relay");
  await other.projects.update({
    workspaceId: relay.id,
    name: relay.name,
    defaults: { provider: "codex", model: "gpt-5-codex", worktree: true, baseBranch: "develop" },
  });

  await made.open("/new?project=relay");
  expect(
    await screen.findByRole("button", { name: "Model: GPT-5 Codex, Personal, Medium effort" }),
  ).toBeTruthy();
  expect(await screen.findByRole("button", { name: "Start from: origin/develop" })).toBeTruthy();
  await userEvent.type(
    await screen.findByRole("combobox", { name: "Message" }),
    "Use the project defaults{Enter}",
  );

  await waitFor(() => {
    const view = made.daemon.snapshot({ kind: "threads" });
    const created =
      view?.kind === "threads" &&
      Object.values(view.threads).find((thread) => thread.title === "Use the project defaults");
    expect(created).toMatchObject({ provider: "codex", details: { mode: "worktree" } });
    expect(created && created.live?.model).toBe("gpt-5-codex");
    expect(created && created.details?.base).toMatchObject({ ref: "develop", remote: "origin" });
  });
});

test("a project that turns worktrees off starts its new threads on the local checkout", async () => {
  const made = harness();
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  const other = fakeClient(made.daemon);
  await ready(other);
  await other.projects.update({
    workspaceId: "relay",
    name: "relay",
    defaults: { worktree: false },
  });

  await made.open("/new?project=relay");
  await userEvent.type(
    await screen.findByRole("combobox", { name: "Message" }),
    "Work in place{Enter}",
  );
  await waitFor(() => {
    const view = made.daemon.snapshot({ kind: "threads" });
    const created =
      view?.kind === "threads" &&
      Object.values(view.threads).find((thread) => thread.title === "Work in place");
    expect(created && created.details?.mode).toBe("local");
  });
});

test("Remove project in the editor stops listing the project and leaves its folder", async () => {
  const made = app();
  const other = fakeClient(made.daemon);
  await ready(other);
  await other.projects.add({ path: "/home/dev/site" });
  await made.open("/new");
  await userEvent.click(await screen.findByRole("button", { name: /^Project filter:/ }));
  await userEvent.pointer({
    keys: "[MouseRight]",
    target: await screen.findByRole("menuitemradio", { name: "site" }),
  });
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit project…" }));
  const editor = await screen.findByRole("dialog", { name: "Edit project" });
  await userEvent.click(within(editor).getByRole("button", { name: "Remove project…" }));

  const confirm = await screen.findByRole("dialog", { name: "Remove site?" });
  expect(within(confirm).getByText(/This won't delete any files/)).toBeTruthy();
  await userEvent.click(within(confirm).getByRole("button", { name: "Remove project" }));

  await waitFor(() =>
    expect(made.daemon.projects.list().workspaces.map((project) => project.name)).not.toContain(
      "site",
    ),
  );
  const folders = await other.projects.browse({ path: "/home/dev", limit: 100, showHidden: false });
  const result = folders.result;
  expect(result.kind === "directories" && result.entries.map((entry) => entry.name)).toContain(
    "site",
  );
});

test("notes the person adds in Edit project are saved for every agent, and removing one deletes it", async () => {
  const made = app();
  await made.open("/new?project=docs");
  await screen.findByRole("button", { name: "Project: docs" });

  let dialog = await openEditor();
  await userEvent.click(within(dialog).getByRole("button", { name: "Add note" }));
  await userEvent.type(within(dialog).getByRole("textbox", { name: "Note 1" }), "Run bun run test");
  await userEvent.click(within(dialog).getByRole("button", { name: "Add note" }));
  await userEvent.type(within(dialog).getByRole("textbox", { name: "Note 2" }), "Never bun test");
  await save(dialog);
  await waitFor(() =>
    expect(saved(made)?.notes?.map((note) => note.text)).toEqual([
      "Run bun run test",
      "Never bun test",
    ]),
  );

  dialog = await openEditor();
  // The saved notes come back in order when the editor opens again.
  expect(within(dialog).getByDisplayValue("Never bun test")).toBe(
    within(dialog).getByRole("textbox", { name: "Note 2" }),
  );
  await userEvent.click(within(dialog).getByRole("button", { name: "Remove note 1" }));
  await save(dialog);
  await waitFor(() =>
    expect(saved(made)?.notes?.map((note) => note.text)).toEqual(["Never bun test"]),
  );
});
