import { chromium, expect as playwrightExpect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const out = "/tmp/ace-orch/shots/fix-cold-start-state";
const base = process.env.ACE_COLD_STATE_URL ?? "http://127.0.0.1:5246";
const themes = ["light", "dark", "midnight", "graphite", "paper", "slate", "contrast"];
const routes = [
  "cold-unsent",
  "cold-uncertain",
  "cold-untouched",
  "cold-legacy",
  "model-cold",
  "skills-cold",
  "skills-ready",
  "slash-cold",
  "slash-ready",
  "skills-switch",
  "providers",
  "opencode",
  "pi",
  "general",
  "free-models",
  "accounts",
  "activity",
];
const selected = process.env.ACE_COLD_STATE_ROUTES?.split(",");
const files: string[] = [];
await mkdir(out, { recursive: true });
const expect = playwrightExpect.configure({ timeout: 30000 });
const browser = await chromium.launch();
try {
  for (const theme of themes)
    for (const width of [1440, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        reducedMotion: "reduce",
      });
      for (const route of ["light", "dark"].includes(theme)
        ? routes
        : ["cold-unsent", "opencode", "pi", "skills-ready"]) {
        if (selected && !selected.includes(route)) continue;
        const page = await context.newPage();
        await page.addInitScript(
          ({ theme: appearance, route: screenName }) => {
            localStorage.setItem("ace.appearance", JSON.stringify({ theme: appearance }));
            Object.assign(globalThis, {
              aceFakeSetup: (daemon: {
                createThread(value: object): void;
                seedServices(value: object): void;
                services: { models: { provider: string }[] };
              }) => {
                daemon.seedServices({ settings: { "providers.default": "claude" } });
                if (["skills-cold", "slash-cold"].includes(screenName))
                  daemon.seedServices({
                    extensionCatalogs: { claude: [] },
                    catalogLoading: ["claude"],
                  });
                if (["slash-cold", "slash-ready"].includes(screenName))
                  daemon.createThread({
                    id: "cold-skills",
                    workspaceId: "relay",
                    provider: "claude",
                    title: "Use the testing workflow",
                  });
                if (screenName === "model-cold")
                  daemon.services.models = daemon.services.models.filter(
                    (row) => row.provider !== "opencode",
                  );
              },
            });
          },
          { theme, route },
        );
        const path =
          route === "providers"
            ? "settings/providers"
            : ["opencode", "pi", "free-models"].includes(route)
              ? `settings/providers/${route === "pi" ? "pi" : "opencode"}`
              : route === "general"
                ? "settings/general"
                : route.startsWith("skills-")
                  ? "skills"
                  : route.startsWith("slash-")
                    ? "t/cold-skills"
                    : ["accounts", "activity"].includes(route)
                      ? route
                      : `t/${route === "model-cold" ? "cold-unsent" : route}`;
        await page.goto(`${base}/${path}?fakeWorld=cold-start-state`);
        if (path.startsWith("t/")) {
          const input = page.getByRole("combobox", { name: "Message" });
          await expect(input).toBeVisible();
          if (route.startsWith("slash-")) {
            await input.fill("/tdd");
            await expect(
              route === "slash-cold"
                ? page.getByText("Loading suggestions…")
                : page.getByRole("option", { name: /^Test Driven Development / }).first(),
            ).toBeVisible();
          } else if (["cold-unsent", "cold-uncertain", "model-cold"].includes(route))
            await expect(page.getByRole("list", { name: "Queued messages" })).toBeVisible();
          else if (route === "cold-legacy")
            await expect(page.getByText("A separate reply stays visible.")).toBeVisible();
        } else if (route === "skills-cold")
          await expect(page.getByRole("status", { name: /Loading skills/ }).first()).toBeVisible();
        else if (route.startsWith("skills-")) {
          await expect(
            page.getByRole("link", { name: "Test Driven Development Global" }),
          ).toBeVisible();
          if (route === "skills-ready" && width === 1440) {
            await page.getByRole("link", { name: "Test Driven Development Global" }).click();
            await expect(
              page.getByRole("heading", { level: 1, name: "Test Driven Development" }),
            ).toBeVisible();
            await expect(
              page.getByText("Write the failing test first.", { exact: true }),
            ).toBeVisible();
          }
          if (route === "skills-switch") {
            await page.getByRole("link", { name: "Test Driven Development Global" }).click();
            await expect(
              page.getByRole("heading", { level: 1, name: "Test Driven Development" }),
            ).toBeVisible();
            if (width === 390) await page.goBack();
            await page.getByRole("combobox", { name: "Skills provider" }).click();
            await page.getByRole("option", { name: "Pi", exact: true }).click();
            await expect(page.getByText("This isn't installed")).toHaveCount(0);
            if (width === 1440) {
              await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
              await expect(page.getByRole("status", { name: "Loading message" })).toHaveCount(0);
            }
          }
        } else if (route === "activity") {
          await page.getByRole("tab", { name: /^Needs you/ }).click();
          await expect(
            page.getByRole("link", { name: "Fix the reconnect: Message not sent" }).first(),
          ).toBeVisible();
        } else if (route === "general") {
          await expect(page.getByRole("combobox", { name: "Pi permissions" })).toBeVisible();
          await page.getByRole("combobox", { name: "Pi permissions" }).scrollIntoViewIfNeeded();
        } else if (route === "free-models") {
          await page.getByRole("button", { name: "Show models" }).click();
          await expect(page.getByText("Exo Free", { exact: true })).toBeVisible();
          await page.getByText("Exo Free", { exact: true }).scrollIntoViewIfNeeded();
        } else if (route === "pi")
          await expect(page.getByRole("img", { name: "Ollama Cloud" })).toBeVisible();
        else if (route === "opencode")
          await expect(page.getByRole("list", { name: "OpenCode services" })).toBeVisible();
        else if (route === "providers")
          await expect(
            page.getByRole("group", { name: "OpenCode" }).getByText("Ready"),
          ).toBeVisible();
        else if (route === "accounts") {
          const row = page
            .getByRole("list", { name: "Headroom now" })
            .getByRole("listitem")
            .filter({ hasText: "OpenCode" });
          await expect(row.getByText(/1 of 1 account can work/)).toBeVisible();
          await row.scrollIntoViewIfNeeded();
        } else await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
        const file = `${route}-${theme}-${width}.png`;
        await page.screenshot({ path: `${out}/${file}`, animations: "disabled" });
        files.push(file);
        console.log(file);
        await page.close();
      }
      await context.close();
    }
  if (!selected)
    await writeFile(
      `${out}/manifest.md`,
      files.map((file) => `- ${out}/${file}`).join("\n") + "\n",
    );
} finally {
  await browser.close();
}
