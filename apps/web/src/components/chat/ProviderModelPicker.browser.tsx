import { type ProviderKind, type ServerProvider } from "@ace/contracts";
import type { ComponentProps } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ProviderModelPicker } from "./ProviderModelPicker";
import { getCustomModelOptionsByProvider } from "../../modelSelection";
import { DEFAULT_UNIFIED_SETTINGS } from "@ace/contracts/settings";

function effort(value: string, isDefault = false) {
  return {
    value,
    label: value,
    ...(isDefault ? { isDefault: true } : {}),
  };
}

const TEST_PROVIDERS: ReadonlyArray<ServerProvider> = [
  {
    provider: "codex",
    enabled: true,
    installed: true,
    version: "0.116.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date().toISOString(),
    models: [
      {
        slug: "gpt-5-codex",
        name: "GPT-5 Codex",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [effort("low"), effort("medium", true), effort("high")],
          supportsFastMode: true,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
      {
        slug: "gpt-5.3-codex",
        name: "GPT-5.3 Codex",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [effort("low"), effort("medium", true), effort("high")],
          supportsFastMode: true,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ],
  },
  {
    provider: "claudeAgent",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date().toISOString(),
    models: [
      {
        slug: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [
            effort("low"),
            effort("medium", true),
            effort("high"),
            effort("max"),
          ],
          supportsFastMode: false,
          supportsThinkingToggle: true,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
      {
        slug: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [
            effort("low"),
            effort("medium", true),
            effort("high"),
            effort("max"),
          ],
          supportsFastMode: false,
          supportsThinkingToggle: true,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
      {
        slug: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [effort("low"), effort("medium", true), effort("high")],
          supportsFastMode: false,
          supportsThinkingToggle: true,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ],
  },
  {
    provider: "cursor",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date().toISOString(),
    models: [
      {
        slug: "cursor-opus-high",
        name: "Cursor Opus High",
        isCustom: false,
        capabilities: null,
        cursorMetadata: {
          familySlug: "cursor-opus",
          familyName: "Cursor Opus",
          reasoningEffort: "high",
          fastMode: false,
          thinking: false,
          maxMode: false,
        },
      },
      {
        slug: "cursor-sonnet-high",
        name: "Cursor Sonnet High",
        isCustom: false,
        capabilities: null,
        cursorMetadata: {
          familySlug: "cursor-sonnet",
          familyName: "Cursor Sonnet",
          reasoningEffort: "high",
          fastMode: false,
          thinking: false,
          maxMode: false,
        },
      },
    ],
  },
];

function buildCodexProvider(models: ServerProvider["models"]): ServerProvider {
  return {
    provider: "codex",
    enabled: true,
    installed: true,
    version: "0.116.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date().toISOString(),
    models,
  };
}

function buildOpenCodeProvider(models: ServerProvider["models"]): ServerProvider {
  return {
    provider: "opencode",
    enabled: true,
    installed: true,
    version: "1.4.3",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date().toISOString(),
    models,
  };
}

function buildPiProvider(models: ServerProvider["models"]): ServerProvider {
  return {
    provider: "pi",
    enabled: true,
    installed: true,
    version: "1.2.3",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date().toISOString(),
    models,
  };
}

function buildCodexModel(index: number): ServerProvider["models"][number] {
  return {
    slug: `codex-model-${index}`,
    name: `Codex Model ${index}`,
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [effort("low"), effort("medium", true), effort("high")],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  };
}

async function mountPicker(props: {
  provider: ProviderKind;
  providerInstanceId?: string;
  providerInstancesByProvider?: ComponentProps<
    typeof ProviderModelPicker
  >["providerInstancesByProvider"];
  model: string;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProvider>;
  triggerVariant?: "ghost" | "outline";
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const onProviderModelChange = vi.fn();
  const providers = props.providers ?? TEST_PROVIDERS;
  const modelOptionsByProvider = getCustomModelOptionsByProvider(
    DEFAULT_UNIFIED_SETTINGS,
    providers,
    props.provider,
    props.model,
    props.providerInstanceId,
  );
  const screen = await render(
    <ProviderModelPicker
      provider={props.provider}
      {...(props.providerInstanceId ? { providerInstanceId: props.providerInstanceId } : {})}
      model={props.model}
      lockedProvider={props.lockedProvider}
      providers={providers}
      modelOptionsByProvider={modelOptionsByProvider}
      {...(props.providerInstancesByProvider
        ? { providerInstancesByProvider: props.providerInstancesByProvider }
        : {})}
      triggerVariant={props.triggerVariant}
      onProviderModelChange={onProviderModelChange}
    />,
    { container: host },
  );

  return {
    onProviderModelChange,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("ProviderModelPicker", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.removeItem("ace:provider-model-picker-prefs:v1");
  });

  it("does not mount a full-window modal backdrop for dropdown menus", async () => {
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: "codex",
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(document.querySelector('[data-slot="menu-popup"]')).toBeInstanceOf(HTMLElement);
      });

      const internalBackdrop = Array.from(
        document.querySelectorAll<HTMLElement>("[data-base-ui-inert]"),
      ).find(
        (element) =>
          element.getAttribute("role") === "presentation" &&
          element.style.position === "fixed" &&
          element.style.inset === "0px",
      );
      expect(internalBackdrop).toBeUndefined();
    } finally {
      await mounted.cleanup();
    }
  });

  it("closes an open dropdown before native resize or app deactivation", async () => {
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: "codex",
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(document.querySelector('[data-slot="menu-popup"]')).toBeInstanceOf(HTMLElement);
      });

      window.dispatchEvent(new CustomEvent("ace:native-window-resize-start"));

      await vi.waitFor(() => {
        expect(document.querySelector('[data-slot="menu-popup"]')).toBeNull();
      });

      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(document.querySelector('[data-slot="menu-popup"]')).toBeInstanceOf(HTMLElement);
      });

      window.dispatchEvent(new FocusEvent("blur"));

      await vi.waitFor(() => {
        expect(document.querySelector('[data-slot="menu-popup"]')).toBeNull();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a provider rail and model pane when provider switching is allowed", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Claude");
        expect(text).toContain("Claude Sonnet 4.6");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("switches the model pane when a provider is clicked", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("button", { name: "Codex" }).click();

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("GPT-5 Codex");
      });
      expect(document.body.textContent ?? "").not.toContain("Claude Sonnet 4.6");
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows models directly when the provider is locked mid-thread", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: "claudeAgent",
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Claude Sonnet 4.6");
        expect(text).toContain("Claude Haiku 4.5");
        expect(text).not.toContain("Codex");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("only shows codex spark when the server reports it for the account", async () => {
    const providersWithoutSpark: ReadonlyArray<ServerProvider> = [
      buildCodexProvider([
        {
          slug: "gpt-5.3-codex",
          name: "GPT-5.3 Codex",
          isCustom: false,
          capabilities: {
            reasoningEffortLevels: [effort("low"), effort("medium", true), effort("high")],
            supportsFastMode: true,
            supportsThinkingToggle: false,
            contextWindowOptions: [],
            promptInjectedEffortLevels: [],
          },
        },
      ]),
      TEST_PROVIDERS[1]!,
    ];
    const providersWithSpark: ReadonlyArray<ServerProvider> = [
      buildCodexProvider([
        {
          slug: "gpt-5.3-codex",
          name: "GPT-5.3 Codex",
          isCustom: false,
          capabilities: {
            reasoningEffortLevels: [effort("low"), effort("medium", true), effort("high")],
            supportsFastMode: true,
            supportsThinkingToggle: false,
            contextWindowOptions: [],
            promptInjectedEffortLevels: [],
          },
        },
        {
          slug: "gpt-5.3-codex-spark",
          name: "GPT-5.3 Codex Spark",
          isCustom: false,
          capabilities: {
            reasoningEffortLevels: [effort("low"), effort("medium", true), effort("high")],
            supportsFastMode: true,
            supportsThinkingToggle: false,
            contextWindowOptions: [],
            promptInjectedEffortLevels: [],
          },
        },
      ]),
      TEST_PROVIDERS[1]!,
    ];

    const hidden = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
      providers: providersWithoutSpark,
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("button", { name: "Codex" }).click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("GPT-5.3 Codex");
        expect(text).not.toContain("GPT-5.3 Codex Spark");
      });
    } finally {
      await hidden.cleanup();
    }

    const visible = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
      providers: providersWithSpark,
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("button", { name: "Codex" }).click();

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("GPT-5.3 Codex Spark");
      });
    } finally {
      await visible.cleanup();
    }
  });

  it("dispatches the canonical slug when a model is selected", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: "claudeAgent",
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("menuitemradio", { name: "Claude Sonnet 4.6" }).click();

      expect(mounted.onProviderModelChange).toHaveBeenCalledWith(
        "claudeAgent",
        "claude-sonnet-4-6",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("pins providers to the top of the provider rail", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("button", { name: "Cursor" }).click();
      await page.getByRole("button", { name: "Pin Cursor" }).click();

      await vi.waitFor(() => {
        const raw = localStorage.getItem("ace:provider-model-picker-prefs:v1") ?? "";
        expect(raw).toContain("cursor");
      });

      const popup = document.querySelector('[data-slot="menu-popup"]');
      if (!(popup instanceof HTMLElement)) {
        throw new Error("Expected provider picker popup to be mounted.");
      }
      const firstProviderButton = Array.from(
        popup.querySelectorAll<HTMLButtonElement>("button[aria-label]"),
      ).find((button) =>
        ["Codex", "Claude", "Cursor", "Copilot", "Gemini", "OpenCode", "Pi"].includes(
          button.getAttribute("aria-label") ?? "",
        ),
      );
      expect(firstProviderButton?.getAttribute("aria-label") ?? "").toBe("Cursor");
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows provider accounts as provider rail entries", async () => {
    const personalModel = buildCodexModel(77);
    const providers = TEST_PROVIDERS.map((provider) =>
      provider.provider === "codex" ? { ...provider, isDefaultProviderInstance: true } : provider,
    ).concat([
      {
        ...buildCodexProvider([personalModel]),
        providerInstanceId: "personal",
        providerInstanceLabel: "Personal",
        isDefaultProviderInstance: false,
      },
    ]);
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: null,
      providers,
      providerInstancesByProvider: {
        codex: [
          { id: "work", label: "Work", enabled: true },
          { id: "personal", label: "Personal", enabled: true },
        ],
      },
    });

    try {
      await page.getByRole("button").click();
      expect(document.body.textContent ?? "").not.toContain("Account");
      expect(document.body.textContent ?? "").not.toContain("Default");
      await expect.element(page.getByRole("button", { name: "Codex Personal" })).toBeVisible();
      await page.getByRole("button", { name: "Codex Personal" }).click();

      expect(mounted.onProviderModelChange).toHaveBeenCalledWith(
        "codex",
        personalModel.slug,
        "personal",
      );
      const popupText = document.body.textContent ?? "";
      expect(popupText).toContain("Personal");
      expect(popupText).toContain("1 model");
      expect(popupText).toContain(personalModel.name);
      expect(popupText).not.toContain("GPT-5.3 Codex");
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps provider account entries selectable when a conversation locks the provider", async () => {
    const personalModel = buildCodexModel(88);
    const providers = TEST_PROVIDERS.map((provider) =>
      provider.provider === "codex" ? { ...provider, isDefaultProviderInstance: true } : provider,
    ).concat([
      {
        ...buildCodexProvider([personalModel]),
        providerInstanceId: "personal",
        providerInstanceLabel: "Personal",
        isDefaultProviderInstance: false,
      },
    ]);
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: "codex",
      providers,
      providerInstancesByProvider: {
        codex: [
          {
            id: "personal",
            label: "Personal",
            enabled: true,
            badgeColor: "blue",
            badgeIcon: "briefcase",
          },
        ],
      },
    });

    try {
      await page.getByRole("button").click();
      await expect.element(page.getByRole("button", { name: "Codex Personal" })).toBeVisible();
      await page.getByRole("button", { name: "Codex Personal" }).click();

      expect(mounted.onProviderModelChange).toHaveBeenCalledWith(
        "codex",
        personalModel.slug,
        "personal",
      );
      expect(document.body.textContent ?? "").toContain(personalModel.name);
      expect(document.body.textContent ?? "").not.toContain("GPT-5.3 Codex");
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps enabled provider accounts selectable when the default entry is disabled", async () => {
    const disabledDefaultCodex = {
      ...buildCodexProvider([buildCodexModel(1)]),
      enabled: false,
      status: "disabled" as const,
      isDefaultProviderInstance: true,
    };
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
      providers: [disabledDefaultCodex, TEST_PROVIDERS[1]!],
      providerInstancesByProvider: {
        codex: [{ id: "personal", label: "Personal", enabled: true }],
      },
    });

    try {
      await page.getByRole("button").click();

      await expect.element(page.getByRole("button", { name: "Codex Personal" })).toBeVisible();
      expect(document.querySelector("button[aria-label='Codex']")).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders the selected instance badge on the composer trigger", async () => {
    const mounted = await mountPicker({
      provider: "codex",
      providerInstanceId: "work",
      model: "gpt-5-codex",
      lockedProvider: null,
      providerInstancesByProvider: {
        codex: [
          {
            id: "work",
            label: "Work",
            enabled: true,
            badgeColor: "emerald",
            badgeIcon: "briefcase",
          },
        ],
      },
    });

    try {
      const trigger = document.querySelector('[data-chat-provider-model-picker="true"]');
      if (!(trigger instanceof HTMLElement)) {
        throw new Error("Expected provider picker trigger to be mounted.");
      }
      const badge = trigger.querySelector('[data-provider-instance-badge="true"]');
      expect(badge).toBeInstanceOf(HTMLElement);
      expect((badge as HTMLElement).style.backgroundColor).toBe("rgb(5, 150, 105)");
    } finally {
      await mounted.cleanup();
    }
  });

  it("favorites models and surfaces them above the model list", async () => {
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: "codex",
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("button", { name: "Favorite GPT-5.3 Codex" }).click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Favorites");
        expect(localStorage.getItem("ace:provider-model-picker-prefs:v1") ?? "").toContain(
          "codex:default:gpt-5.3-codex",
        );
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps favorite models scoped to the selected provider account", async () => {
    const providers = TEST_PROVIDERS.map((provider) =>
      provider.provider === "codex" ? { ...provider, isDefaultProviderInstance: true } : provider,
    ).concat([
      {
        ...buildCodexProvider(TEST_PROVIDERS[0]!.models),
        providerInstanceId: "personal",
        providerInstanceLabel: "Personal",
        isDefaultProviderInstance: false,
      },
    ]);
    const providerInstancesByProvider = {
      codex: [{ id: "personal", label: "Personal", enabled: true }],
    };
    const defaultMounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: "codex",
      providers,
      providerInstancesByProvider,
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("button", { name: "Favorite GPT-5.3 Codex" }).click();
    } finally {
      await defaultMounted.cleanup();
    }

    const personalMounted = await mountPicker({
      provider: "codex",
      providerInstanceId: "personal",
      model: "gpt-5-codex",
      lockedProvider: "codex",
      providers,
      providerInstancesByProvider,
    });

    try {
      await page.getByRole("button").click();

      expect(document.body.textContent ?? "").not.toContain("Favorites");
      expect(localStorage.getItem("ace:provider-model-picker-prefs:v1") ?? "").toContain(
        "codex:default:gpt-5.3-codex",
      );
    } finally {
      await personalMounted.cleanup();
    }
  });

  it("hides disabled providers from the provider menu", async () => {
    const disabledProviders = TEST_PROVIDERS.slice();
    const claudeIndex = disabledProviders.findIndex(
      (provider) => provider.provider === "claudeAgent",
    );
    if (claudeIndex >= 0) {
      const claudeProvider = disabledProviders[claudeIndex]!;
      disabledProviders[claudeIndex] = {
        ...claudeProvider,
        enabled: false,
        status: "disabled",
      };
    }
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: null,
      providers: disabledProviders,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).not.toContain("Claude");
        expect(text).not.toContain("Disabled");
        expect(text).not.toContain("Claude Sonnet 4.6");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps upgrade-needed providers selectable", async () => {
    const outdatedProviders: ReadonlyArray<ServerProvider> = TEST_PROVIDERS.map((provider) =>
      provider.provider === "codex"
        ? {
            ...provider,
            version: "0.12.0",
            minimumVersion: "0.37.0",
            versionStatus: "upgrade-required",
            status: "warning",
            message:
              "Upgrade needed: Codex CLI v0.12.0 is below ace's minimum supported version v0.37.0. Upgrade Codex CLI and restart ace.",
          }
        : provider,
    );
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
      providers: outdatedProviders,
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("button", { name: "Codex" }).click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("GPT-5 Codex");
        expect(text).not.toContain("Unavailable");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("groups OpenCode models by provider and filters via the top search field", async () => {
    const mounted = await mountPicker({
      provider: "opencode",
      model: "github-copilot/claude-sonnet-4-6",
      lockedProvider: "opencode",
      providers: [
        buildOpenCodeProvider([
          {
            slug: "github-copilot/claude-sonnet-4-6",
            name: "GitHub Copilot: Claude Sonnet 4.6",
            isCustom: false,
            capabilities: null,
          },
          {
            slug: "opencode-go/codex-5.3",
            name: "OpenCode Go: Codex 5.3",
            isCustom: false,
            capabilities: null,
          },
          {
            slug: "lmstudio/qwen3.5-30b",
            name: "LMStudio: Qwen 3.5 30B",
            isCustom: false,
            capabilities: null,
          },
          {
            slug: "lmstudio/nemotron",
            name: "LMStudio: Nemotron",
            isCustom: false,
            capabilities: null,
          },
        ]),
      ],
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const popup = document.querySelector('[data-slot="menu-popup"]');
        if (!(popup instanceof HTMLElement)) {
          throw new Error("Expected OpenCode popup to be mounted.");
        }
        const text = popup.textContent ?? "";
        expect(text).toContain("GitHub Copilot");
        expect(text).toContain("OpenCode Go");
        expect(text).toContain("LMStudio");
        expect(text).toContain("Claude Sonnet 4.6");
        expect(text).toContain("Codex 5.3");
        expect(text).toContain("Qwen 3.5 30B");
        expect(text).toContain("Nemotron");
      });
      const popup = document.querySelector('[data-slot="menu-popup"]');
      if (!(popup instanceof HTMLElement)) {
        throw new Error("Expected OpenCode popup to remain mounted.");
      }
      const initialPopupHeight = popup.getBoundingClientRect().height;

      const searchInput = document.querySelector('input[type="search"]');
      if (!(searchInput instanceof HTMLInputElement)) {
        throw new Error("Expected OpenCode model search input to be mounted.");
      }
      expect(searchInput.className).toContain("border-0");
      expect(searchInput.parentElement?.className ?? "").toContain("border");

      await page.getByRole("searchbox").fill("nemotron");

      await vi.waitFor(() => {
        const popup = document.querySelector('[data-slot="menu-popup"]');
        if (!(popup instanceof HTMLElement)) {
          throw new Error("Expected OpenCode popup to remain mounted.");
        }
        const text = popup.textContent ?? "";
        expect(text).toContain("LMStudio");
        expect(text).toContain("Nemotron");
        expect(text).not.toContain("Claude Sonnet 4.6");
        expect(text).not.toContain("Codex 5.3");
      });

      const filteredPopup = document.querySelector('[data-slot="menu-popup"]');
      if (!(filteredPopup instanceof HTMLElement)) {
        throw new Error("Expected OpenCode popup to remain mounted after filtering.");
      }
      const filteredPopupHeight = filteredPopup.getBoundingClientRect().height;
      expect(filteredPopupHeight).toBeLessThanOrEqual(initialPopupHeight);
    } finally {
      await mounted.cleanup();
    }
  });

  it("caps locked-provider model menus and scrolls within the popup", async () => {
    const initialViewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1280, 1200);
    const manyCodexModels = Array.from({ length: 32 }, (_, index) => buildCodexModel(index + 1));
    const mounted = await mountPicker({
      provider: "codex",
      model: manyCodexModels[0]!.slug,
      lockedProvider: "codex",
      providers: [buildCodexProvider(manyCodexModels), TEST_PROVIDERS[1]!],
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(document.querySelectorAll('[role="menuitemradio"]').length).toBe(
          manyCodexModels.length,
        );
      });

      const popup = document.querySelector('[data-slot="menu-popup"]');
      if (!(popup instanceof HTMLElement)) {
        throw new Error("Expected the locked-provider popup to be mounted.");
      }

      const scrollContainer = popup.firstElementChild;
      if (!(scrollContainer instanceof HTMLElement)) {
        throw new Error("Expected the locked-provider popup to render a scroll container.");
      }

      expect(scrollContainer.getBoundingClientRect().height).toBeLessThanOrEqual(400);
      expect(scrollContainer.scrollHeight).toBeGreaterThan(scrollContainer.clientHeight);
    } finally {
      await mounted.cleanup();
      await page.viewport(initialViewport.width, initialViewport.height);
    }
  });

  it("accepts outline trigger styling", async () => {
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: null,
      triggerVariant: "outline",
    });

    try {
      const button = document.querySelector("button");
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error("Expected picker trigger button to be rendered.");
      }
      expect(button.dataset.variant).toBe("outline");
      expect(button.className).toContain("border-border");
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders Cursor family options without a section header label", async () => {
    const mounted = await mountPicker({
      provider: "cursor",
      model: "cursor-opus-high",
      lockedProvider: "cursor",
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Cursor Opus");
        expect(text).toContain("Cursor Sonnet");
        expect(text).not.toContain("Model Family");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("groups Pi models by upstream provider and filters via the top search field", async () => {
    const mounted = await mountPicker({
      provider: "pi",
      model: "openai/gpt-5.5",
      lockedProvider: "pi",
      providers: [
        buildPiProvider([
          {
            slug: "openai/gpt-5.5",
            name: "GPT-5.5",
            isCustom: false,
            capabilities: null,
          },
          {
            slug: "anthropic/claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            isCustom: false,
            capabilities: null,
          },
          {
            slug: "google/gemini-2.5-pro",
            name: "Gemini 2.5 Pro",
            isCustom: false,
            capabilities: null,
          },
          {
            slug: "google/gemini-2.5-flash",
            name: "Gemini 2.5 Flash",
            isCustom: false,
            capabilities: null,
          },
        ]),
      ],
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const popup = document.querySelector('[data-slot="menu-popup"]');
        if (!(popup instanceof HTMLElement)) {
          throw new Error("Expected Pi popup to be mounted.");
        }
        const text = popup.textContent ?? "";
        expect(text).toContain("OpenAI");
        expect(text).toContain("Anthropic");
        expect(text).toContain("Google");
        expect(text).toContain("GPT-5.5");
        expect(text).toContain("Claude Sonnet 4.6");
        expect(text).toContain("Gemini 2.5 Pro");
        expect(text).toContain("Gemini 2.5 Flash");
      });

      await page.getByRole("searchbox").fill("flash");

      await vi.waitFor(() => {
        const popup = document.querySelector('[data-slot="menu-popup"]');
        if (!(popup instanceof HTMLElement)) {
          throw new Error("Expected Pi popup to remain mounted.");
        }
        const text = popup.textContent ?? "";
        expect(text).toContain("Google");
        expect(text).toContain("Gemini 2.5 Flash");
        expect(text).not.toContain("GPT-5.5");
        expect(text).not.toContain("Claude Sonnet 4.6");
      });
    } finally {
      await mounted.cleanup();
    }
  });
});
