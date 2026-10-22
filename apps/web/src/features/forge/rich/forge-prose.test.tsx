import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { expect, test } from "vitest";
import { Client } from "@ace/client";
import { ClientProvider } from "@ace/client-react";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { ClientMessage, DeviceId } from "@ace/protocol";
import { memoryStorage } from "@/boot/client.ts";
import { ThemeProvider } from "@/theme/theme-provider.tsx";
import { ToastProvider } from "@/components/ui/toast.tsx";
import { ForgeProse } from "./forge-prose.tsx";
import { ForgeContentScope } from "./scope.ts";

const asset = (id: string) => `https://github.com/user-attachments/assets/${id}`;
const before = asset("1b5f0c1e-6a2f-4e8b-9c11-0a7d3e5f2b41");
const recording = asset("3d7b2e3a-8c4f-4a0d-9e33-2c9f5a7b4d63");
const missing = asset("4e8c3f4b-9d5a-4b1e-8f44-3d0a6b8c5e74");
const logoLight = "https://raw.githubusercontent.com/acme/ace/main/docs/logo-light.svg";
const logoDark = "https://raw.githubusercontent.com/acme/ace/main/docs/logo-dark.svg";
const repository = { forge: "github", host: "github.com", owner: "acme", name: "ace" } as const;

/**
 * A client of the fake daemon that records which media URLs it asked the daemon about.
 * `evicted` answers the first media download as a daemon whose cache dropped the file would.
 */
async function connected(options: { evicted?: boolean } = {}) {
  let evicted = options.evicted ?? false;
  const daemon = new FakeDaemon({ clock: () => 1_000 });
  // Media downloads are read-only reads of a registered project.
  daemon.projects.seedFolders("/fake", [{ path: "/fake/ace", git: true }]);
  const added = daemon.projects.command({ type: "workspace.add", path: "/fake/ace" });
  const workspaceId = added && "workspace" in added ? String(added.workspace?.id) : "ace";
  const asked: string[] = [];
  let ids = 0;
  const client = new Client({
    deviceId: DeviceId.parse("forge-media-device"),
    credential: async () => daemon.token,
    storage: memoryStorage(),
    id: () => `media-${++ids}`,
    random: () => 0.5,
    scheduler: {
      set(delay, callback) {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    transport: () => {
      const transport = fakeTransport(daemon);
      let reply: ((text: string) => void) | undefined;
      return {
        ...transport,
        open(events) {
          reply = events.message;
          transport.open(events);
        },
        send(text) {
          const message = ClientMessage.parse(JSON.parse(text));
          if (
            evicted &&
            message.type === "files.request" &&
            message.operation.op === "forge.media.download"
          ) {
            evicted = false;
            reply?.(
              JSON.stringify({
                type: "files.error",
                requestId: message.requestId,
                code: "NOT_FOUND",
                message: "Media unavailable",
              }),
            );
            return;
          }
          if (
            message.type === "workspace.request" &&
            message.operation.op === "forge.media.resolve"
          )
            asked.push(...message.operation.items.map((item) => item.url));
          transport.send(text);
        },
      };
    },
  });
  await client.start();
  await expect.poll(() => client.state).toBe("ready");
  return { client, asked, workspaceId };
}

function page(
  { client, workspaceId }: { client: Client; workspaceId: string },
  children: ReactNode,
  dark = false,
) {
  return render(
    <ThemeProvider
      environment={{
        storage: { getItem: () => null, setItem() {}, removeItem() {} },
        root: document.createElement("div"),
        matchMedia: (query) =>
          ({
            matches: dark && query.includes("dark"),
            addEventListener() {},
            removeEventListener() {},
          }) as unknown as MediaQueryList,
      }}
    >
      <ToastProvider>
        <ClientProvider client={client}>
          <ForgeContentScope value={{ workspaceId, repository }}>{children}</ForgeContentScope>
        </ClientProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
}

test("raw HTML draws only GitHub's subset; scripts, frames, handlers and styles never become markup", async () => {
  const daemon = await connected();
  const { container } = page(
    daemon,
    <ForgeProse
      text={[
        "<details>",
        "<summary>More</summary>",
        "",
        "hidden **bold**",
        "",
        "</details>",
        "",
        '<p align="center" style="color:red" onclick="steal()">Hi <b>there</b></p>',
        "",
        "<script>alert(1)</script>",
        "",
        '<iframe src="https://evil.example"></iframe>',
        "",
        '<a href="javascript:alert(1)">bad</a> and <a href="https://ok.dev">ok</a>',
        "",
        "<!-- a note for reviewers -->",
      ].join("\n")}
    />,
  );
  const summary = await screen.findByText("More");
  expect(summary.closest("summary")).toBeTruthy();
  expect(container.querySelector("details strong")?.textContent).toBe("bold");
  const paragraph = screen.getByText("there").closest("p");
  expect(paragraph?.className).toContain("text-center");
  expect(paragraph?.getAttribute("style")).toBeNull();
  expect(paragraph?.getAttribute("onclick")).toBeNull();
  expect(container.querySelector("script, iframe")).toBeNull();
  expect(container.textContent).toContain("<script>alert(1)</script>");
  expect(container.textContent).toContain('<iframe src="https://evil.example">');
  expect(screen.getByRole("link", { name: "ok" }).getAttribute("href")).toBe("https://ok.dev/");
  expect(screen.queryByRole("link", { name: "bad" })).toBeNull();
  expect(container.textContent).not.toContain("a note for reviewers");
});

test("an uploaded image shows the daemon's bytes at the size its text asks for, and opens the viewer", async () => {
  const daemon = await connected();
  const user = userEvent.setup();
  const { container } = page(
    daemon,
    <ForgeProse text={`<img width="400" height="225" alt="Before" src="${before}">`} />,
  );
  const button = await screen.findByRole("button", { name: "View Before" });
  const image = button.querySelector("img");
  // An SVG is never a same-origin blob: opened on its own, it has no origin to act in.
  expect(image?.getAttribute("src")).toMatch(/^data:image\/svg\+xml;base64,/);
  expect(container.querySelector('img[src^="blob:"]')).toBeNull();
  expect(image?.style.width).toBe("400px");
  // The page never loads anything from GitHub itself.
  expect(container.innerHTML).not.toContain("github.com/user-attachments");
  await user.click(button);
  expect(await screen.findByRole("dialog")).toBeTruthy();
});

test("media that can't be shown says so in one line and offers it on GitHub", async () => {
  const daemon = await connected();
  page(daemon, <ForgeProse text={`Old: ![Old layout](${missing})`} />);
  expect(await screen.findByText(/“Old layout” couldn't load\./)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open on GitHub" }).getAttribute("href")).toBe(missing);
});

test("a picture shows its dark variant in dark mode and asks for nothing else", async () => {
  const daemon = await connected();
  const { asked } = daemon;
  page(
    daemon,
    <ForgeProse
      text={[
        "<picture>",
        `  <source media="(prefers-color-scheme: dark)" srcset="${logoDark}">`,
        `  <img alt="ace logo" src="${logoLight}" width="240">`,
        "</picture>",
      ].join("\n")}
    />,
    true,
  );
  await screen.findByRole("button", { name: "View ace logo" });
  expect(asked).toEqual([logoDark]);
});

test("an uploaded recording alone on its line plays inline; a plain link stays a link", async () => {
  const daemon = await connected();
  const { container } = page(
    daemon,
    <ForgeProse text={`${recording}\n\nhttps://example.com/release-notes`} />,
  );
  await waitFor(() =>
    expect(container.querySelector("video")?.getAttribute("src")).toMatch(/^blob:/),
  );
  expect(container.querySelector("video")?.hasAttribute("controls")).toBe(true);
  expect(
    screen.getByRole("link", { name: "https://example.com/release-notes" }).getAttribute("href"),
  ).toBe("https://example.com/release-notes");
});

test("ticking a task box saves the text with only that box changed; without an edit it only shows", async () => {
  const daemon = await connected();
  const user = userEvent.setup();
  const text = "- [ ] Rebase\n- [x] Lint\n\n```\n- [ ] not a task\n```";
  const saved: string[] = [];
  const { unmount } = page(
    daemon,
    <ForgeProse
      text={text}
      tasks={async (next) => {
        saved.push(next);
        return true;
      }}
    />,
  );
  const [first] = await screen.findAllByRole("checkbox");
  if (!first) throw new Error("No task box");
  await user.click(first);
  expect(saved).toEqual(["- [x] Rebase\n- [x] Lint\n\n```\n- [ ] not a task\n```"]);
  expect((first as HTMLInputElement).checked).toBe(true);
  unmount();
  page(daemon, <ForgeProse text={text} />);
  const [readOnly] = await screen.findAllByRole("checkbox");
  if (!readOnly) throw new Error("No task box");
  await user.click(readOnly);
  expect((readOnly as HTMLInputElement).checked).toBe(false);
});

test("alerts, emoji, mentions and footnotes read as GitHub draws them", async () => {
  const daemon = await connected();
  const { container } = page(
    daemon,
    <ForgeProse
      text={"> [!WARNING]\n> Careful\n\nShipped :tada: thanks @octocat[^1]\n\n[^1]: Since 2.0."}
    />,
  );
  const note = await screen.findByRole("note");
  expect(note.textContent).toContain("Warning");
  expect(note.textContent).toContain("Careful");
  expect(container.textContent).not.toContain("[!WARNING]");
  expect(await screen.findByRole("img", { name: "tada" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "@octocat" }).getAttribute("href")).toBe(
    "https://github.com/octocat",
  );
  expect(screen.getByRole("link", { name: "Footnote 1" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Footnotes" }).textContent).toContain("Since 2.0.");
  expect(container.textContent).not.toContain("[^1]");
});

test("media the daemon no longer holds is resolved again and shows, rather than staying broken", async () => {
  const daemon = await connected({ evicted: true });
  page(daemon, <ForgeProse text={`<img width="400" height="225" alt="Before" src="${before}">`} />);
  const button = await screen.findByRole("button", { name: "View Before" });
  expect(button.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/svg\+xml;base64,/);
  expect(daemon.asked).toEqual([before, before]);
});

test("whatever raw HTML tries, the drawn page holds no handler, style or unsafe link", async () => {
  const daemon = await connected();
  const { container } = page(
    daemon,
    <ForgeProse
      text={[
        '<a href="jav&#x09;ascript:alert(1)">tab</a> <a href=" javascript:alert(2)">space</a>',
        '<a href="data:text/html,x">data</a> <a href="//evil.example">relative</a>',
        '<a href="https://ok.dev" target="_top" onclick="x()">ok</a>',
        '<img src="https://ok.dev/a.png"onerror=alert(3)> <img src=`x` onerror=alert(4)>',
        "",
        "<svg><script>alert(5)</script></svg> <math><mi>x</mi></math>",
      ].join("\n")}
    />,
  );
  await screen.findByRole("link", { name: "ok" });
  for (const element of container.querySelectorAll("*")) {
    for (const attribute of element.getAttributeNames()) {
      expect(attribute.startsWith("on")).toBe(false);
      expect(attribute).not.toBe("style");
    }
    // ace's own links open apart from the page; the text's `target` never survives.
    const target = element.getAttribute("target");
    if (target !== null)
      expect([target, element.getAttribute("rel")]).toEqual(["_blank", "noreferrer noopener"]);
    const url = element.getAttribute("href") ?? element.getAttribute("src");
    if (url !== null) expect(url).toMatch(/^(https?:|mailto:|#|blob:|data:image\/svg\+xml)/);
  }
  expect(container.querySelector("svg script, math, iframe")).toBeNull();
});

test("code and link text stay as written; a raw video plays; outside media offers its original", async () => {
  const daemon = await connected();
  const { container } = page(
    daemon,
    <ForgeProse
      text={[
        '<a href="https://ok.dev">ping @octocat about #12</a> and <code>@octocat #12</code>',
        "",
        `<video src="${recording}"></video>`,
        "",
        '<ol type="a"><li>first</li></ol>',
        "",
        "![Gone](https://cdn.example.com/gone.png)",
      ].join("\n")}
    />,
  );
  const link = await screen.findByRole("link", { name: "ping @octocat about #12" });
  expect(link.querySelector("a")).toBeNull();
  expect(container.querySelector("code")?.textContent).toBe("@octocat #12");
  expect(container.querySelector("code a")).toBeNull();
  await waitFor(() =>
    expect(container.querySelector("video")?.getAttribute("src")).toMatch(/^blob:/),
  );
  expect(container.querySelector("video")?.hasAttribute("controls")).toBe(true);
  expect(container.querySelector("ol")?.className).toContain("lower-alpha");
  expect(await screen.findByRole("link", { name: "Open original" })).toBeTruthy();
});

test("commits, other repositories' references and GitHub's image emoji link and draw as on GitHub", async () => {
  const daemon = await connected();
  const sha = "4f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39";
  page(
    daemon,
    <ForgeProse
      text={`See acme/billing-api#74, ${sha}, octo/tools@4f2a9c1 and deadbeef. Made with :octocat:.`}
    />,
  );
  expect(
    (await screen.findByRole("link", { name: "acme/billing-api#74" })).getAttribute("href"),
  ).toBe("https://github.com/acme/billing-api/issues/74");
  expect(screen.getByRole("link", { name: "4f2a9c1" }).getAttribute("href")).toBe(
    `https://github.com/acme/ace/commit/${sha}`,
  );
  expect(screen.getByRole("link", { name: "octo/tools@4f2a9c1" }).getAttribute("href")).toBe(
    "https://github.com/octo/tools/commit/4f2a9c1",
  );
  expect(screen.queryByRole("link", { name: "deadbeef" })).toBeNull();
  const octocat = await screen.findByRole("img", { name: ":octocat:" });
  expect(octocat.getAttribute("src")).toMatch(/^data:image\/svg\+xml;base64,/);
});
