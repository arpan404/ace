import "../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useState } from "react";

import type { BrowserTabState } from "~/lib/browser/session";
import { BROWSER_NEW_TAB_URL } from "~/lib/browser/session";
import {
  BrowserTabWebview,
  buildBrowserElementCaptureScript,
} from "./browser/BrowserWebviewSurface";
import { InAppBrowser } from "./InAppBrowser";

const { useInAppBrowserStateMock } = vi.hoisted(() => ({
  useInAppBrowserStateMock: vi.fn(),
}));

vi.mock("~/hooks/useInAppBrowserState", async () => {
  const actual = await vi.importActual<typeof import("~/hooks/useInAppBrowserState")>(
    "~/hooks/useInAppBrowserState",
  );

  return {
    ...actual,
    useInAppBrowserState: useInAppBrowserStateMock,
  };
});

function createTab(id: string, title: string): BrowserTabState {
  return {
    id,
    title,
    url: BROWSER_NEW_TAB_URL,
  };
}

function createHookState(tabs: readonly BrowserTabState[], activeTabId = tabs[0]?.id ?? null) {
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null;

  return {
    activateTab: vi.fn(),
    activeRuntime: {
      canGoBack: false,
      canGoForward: false,
      devToolsOpen: false,
      loading: false,
    },
    activeTab,
    activeTabIsInternal: true,
    activeTabIsNewTab: true,
    activeTabIsPinned: false,
    addressBarSuggestions: [],
    addressInputRef: { current: null },
    applySuggestion: vi.fn(),
    browserHistoryCount: 0,
    browserResetKey: 0,
    browserSearchEngine: "google",
    browserSession: {
      activeTabId: activeTab?.id ?? "",
      panelHeight: 420,
      tabs,
    },
    browserShellStyle: undefined,
    browserStatusLabel: null,
    clearHistory: vi.fn(),
    closeTab: vi.fn(),
    designerState: {
      active: false,
      pillPosition: null,
      tool: "area-comment",
    },
    draftUrl: "",
    exportPinnedPages: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    handleAddressBarKeyDown: vi.fn(),
    handleBrowserKeyDownCapture: vi.fn(),
    handleTabSnapshotChange: vi.fn(),
    handleWebviewContextMenuFallbackRequest: vi.fn(),
    importPinnedPages: vi.fn(),
    isRepairingStorage: false,
    openActiveTabExternally: vi.fn(),
    openNewTab: vi.fn(),
    openPinnedPage: vi.fn(),
    openTabContextMenu: vi.fn().mockResolvedValue(undefined),
    openUrl: vi.fn(),
    pinnedPages: [],
    reorderTabs: vi.fn(),
    registerWebviewHandle: vi.fn(),
    reload: vi.fn(),
    removePinnedPage: vi.fn(),
    repairBrowserStorage: vi.fn(),
    selectDesignerTool: vi.fn(),
    selectSearchEngine: vi.fn(),
    selectedSuggestionIndex: 0,
    setDesignerModeActive: vi.fn(),
    setDesignerPillPosition: vi.fn(),
    setDraftUrl: vi.fn(),
    setIsAddressBarFocused: vi.fn(),
    setSelectedSuggestionIndex: vi.fn(),
    showAddressBarSuggestions: false,
    toggleDevTools: vi.fn(),
    togglePinnedActivePage: vi.fn(),
  };
}

const originalElementFromPoint = document.elementFromPoint.bind(document);
const originalElementsFromPoint = document.elementsFromPoint.bind(document);
const originalInnerWidth = window.innerWidth;
const originalInnerHeight = window.innerHeight;
const originalCreateElement = document.createElement.bind(document);

function evaluateDesignerCapture(
  point: { x: number; y: number },
  overlayViewport?: { width: number; height: number },
) {
  return new Function(`return ${buildBrowserElementCaptureScript(point, overlayViewport)}`)() as {
    target: { id: string | null } | null;
    targetRect: { height: number; width: number; x: number; y: number } | null;
  };
}

function mockRect(
  element: Element,
  rect: { bottom: number; height: number; left: number; right: number; top: number; width: number },
) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => rect,
  });
}

function mockHitStack(elements: Element[]) {
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => elements[0] ?? null,
  });
  Object.defineProperty(document, "elementsFromPoint", {
    configurable: true,
    value: () => elements,
  });
}

describe("InAppBrowser tab strip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens the tab context menu on right click and closes tabs on middle click", async () => {
    const tabs = [createTab("tab-1", "Alpha Workspace"), createTab("tab-2", "Beta Docs")];
    const hookState = createHookState(tabs);
    useInAppBrowserStateMock.mockReturnValue(hookState);

    await render(
      <div style={{ position: "relative", width: "720px", height: "560px" }}>
        <InAppBrowser
          open
          mode="full"
          onClose={() => undefined}
          onRestore={() => undefined}
          onSplit={() => undefined}
        />
      </div>,
    );

    const alphaTab = document.querySelector(
      '[title="Alpha Workspace"]',
    ) as HTMLButtonElement | null;
    expect(alphaTab).toBeTruthy();
    alphaTab?.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 48, clientY: 64 }),
    );
    expect(hookState.openTabContextMenu).toHaveBeenCalledWith(
      "tab-1",
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    );

    const betaTab = document.querySelector('[title="Beta Docs"]') as HTMLButtonElement | null;
    expect(betaTab).toBeTruthy();
    betaTab?.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(hookState.closeTab).toHaveBeenCalledWith("tab-2");
  });

  it("shows overflow controls and scrolls the tab strip", async () => {
    const tabs = Array.from({ length: 10 }, (_, index) =>
      createTab(`tab-${index + 1}`, `Research Surface ${index + 1}`),
    );
    const hookState = createHookState(tabs, tabs[tabs.length - 1]?.id);
    useInAppBrowserStateMock.mockReturnValue(hookState);

    const screen = await render(
      <div style={{ position: "relative", width: "360px", height: "560px" }}>
        <InAppBrowser
          open
          mode="full"
          onClose={() => undefined}
          onRestore={() => undefined}
          onSplit={() => undefined}
        />
      </div>,
    );

    await expect.element(screen.getByLabelText("Scroll tabs right")).toBeVisible();

    const tabStrip = document.querySelector('[data-testid="browser-tab-strip"]') as HTMLDivElement;
    expect(tabStrip).toBeTruthy();
    let simulatedScrollLeft = 0;
    Object.defineProperty(tabStrip, "scrollLeft", {
      configurable: true,
      get: () => simulatedScrollLeft,
      set: (value: number) => {
        simulatedScrollLeft = value;
      },
    });
    tabStrip.scrollBy = ((options?: ScrollToOptions | number) => {
      const nextLeft = typeof options === "number" ? options : Number(options?.left ?? 0);
      tabStrip.scrollLeft += nextLeft;
      tabStrip.dispatchEvent(new Event("scroll"));
    }) as typeof tabStrip.scrollBy;
    const initialScrollLeft = tabStrip.scrollLeft;

    const scrollRightButton = document.querySelector(
      '[aria-label="Scroll tabs right"]',
    ) as HTMLButtonElement;
    expect(scrollRightButton).toBeTruthy();
    scrollRightButton.click();

    await vi.waitFor(() => {
      expect(tabStrip.scrollLeft).toBeGreaterThan(initialScrollLeft);
    });
    await expect.element(screen.getByLabelText("Scroll tabs left")).toBeVisible();
  });

  it("supports keyboard navigation across tabs", async () => {
    const tabs = [
      createTab("tab-1", "Alpha Workspace"),
      createTab("tab-2", "Beta Docs"),
      createTab("tab-3", "Gamma Notes"),
    ];
    const hookState = createHookState(tabs);
    useInAppBrowserStateMock.mockReturnValue(hookState);

    await render(
      <div style={{ position: "relative", width: "720px", height: "560px" }}>
        <InAppBrowser
          open
          mode="full"
          onClose={() => undefined}
          onRestore={() => undefined}
          onSplit={() => undefined}
        />
      </div>,
    );

    const alphaTab = document.querySelector(
      '[role="tab"][title="Alpha Workspace"]',
    ) as HTMLButtonElement | null;
    expect(alphaTab).toBeTruthy();
    alphaTab?.focus();
    alphaTab?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));

    expect(hookState.activateTab).toHaveBeenCalledWith("tab-2");

    const betaTab = document.querySelector(
      '[role="tab"][title="Beta Docs"]',
    ) as HTMLButtonElement | null;
    expect(betaTab).toBeTruthy();
    betaTab?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "End" }));

    expect(hookState.activateTab).toHaveBeenCalledWith("tab-3");
  });
});

describe("BrowserTabWebview lifecycle", () => {
  afterEach(() => {
    Object.defineProperty(document, "createElement", {
      configurable: true,
      value: originalCreateElement,
    });
    document.body.innerHTML = "";
  });

  it("does not recreate the native webview when design callback props change", async () => {
    const createdWebviews: Array<HTMLElement & { stop: ReturnType<typeof vi.fn> }> = [];
    Object.defineProperty(document, "createElement", {
      configurable: true,
      value: ((tagName: string, options?: ElementCreationOptions) => {
        if (tagName.toLowerCase() !== "webview") {
          return originalCreateElement(tagName, options);
        }
        const webview = originalCreateElement("webview") as HTMLElement & {
          canGoBack: () => boolean;
          canGoForward: () => boolean;
          closeDevTools: () => void;
          getTitle: () => string;
          getURL: () => string;
          isDevToolsOpened: () => boolean;
          isLoading: () => boolean;
          loadURL: (url: string) => Promise<void>;
          openDevTools: () => void;
          reload: () => void;
          stop: ReturnType<typeof vi.fn>;
        };
        let currentUrl = "https://example.com/";
        webview.canGoBack = () => false;
        webview.canGoForward = () => false;
        webview.closeDevTools = () => undefined;
        webview.getTitle = () => "Example";
        webview.getURL = () => currentUrl;
        webview.isDevToolsOpened = () => false;
        webview.isLoading = () => false;
        webview.loadURL = async (url: string) => {
          currentUrl = url;
        };
        webview.openDevTools = () => undefined;
        webview.reload = () => undefined;
        webview.stop = vi.fn();
        createdWebviews.push(webview);
        return webview;
      }) as typeof document.createElement,
    });

    const tab: BrowserTabState = {
      id: "tab-1",
      title: "Example",
      url: "https://example.com/",
    };
    function WebviewHarness() {
      const [renderCount, setRenderCount] = useState(0);
      return (
        <div style={{ height: "320px", width: "480px" }}>
          <button type="button" onClick={() => setRenderCount((current) => current + 1)}>
            Rerender {renderCount}
          </button>
          <BrowserTabWebview
            active
            designerModeActive={false}
            designerTool="area-comment"
            onContextMenuFallbackRequest={() => undefined}
            onDesignCaptureCancel={() => undefined}
            onDesignCaptureError={() => undefined}
            onHandleChange={() => undefined}
            onSnapshotChange={() => undefined}
            tab={tab}
          />
        </div>
      );
    }

    const screen = await render(<WebviewHarness />);
    await vi.waitFor(() => {
      expect(createdWebviews).toHaveLength(1);
    });

    const rerenderButton = document.querySelector("button") as HTMLButtonElement | null;
    expect(rerenderButton).toBeTruthy();
    rerenderButton?.click();

    await vi.waitFor(() => {
      expect(createdWebviews).toHaveLength(1);
    });
    expect(createdWebviews[0]?.stop).not.toHaveBeenCalled();

    await screen.unmount();
  });
});

describe("designer element capture", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    document.body.removeAttribute("style");
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: originalElementFromPoint,
    });
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: originalElementsFromPoint,
    });
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: originalInnerWidth,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
  });

  it("prefers the bounded visible card over a larger layout wrapper", () => {
    document.body.innerHTML = `
      <main id="root" style="position: relative; width: 1280px; height: 720px; background: #0f0f0f;">
        <section
          id="outer"
          style="
            display: flex;
            align-items: center;
            padding: 0 120px 0 36px;
            background: linear-gradient(180deg, rgba(20,24,36,0.55), rgba(20,24,36,0.22));
            border-radius: 28px;
          "
        >
          <div
            id="card"
            style="
              width: 760px;
              height: 154px;
              margin: 0 auto;
              border-radius: 24px;
              background: rgba(45, 51, 61, 0.96);
              box-shadow: 0 10px 30px rgba(0,0,0,0.35);
              display: flex;
              align-items: center;
              justify-content: center;
              color: white;
              font: 600 30px/1.2 sans-serif;
            "
          >
            <div id="title">Try searching to get started</div>
          </div>
        </section>
      </main>
    `;
    const root = document.getElementById("root");
    const outer = document.getElementById("outer");
    const card = document.getElementById("card");
    const title = document.getElementById("title");

    expect(root).toBeTruthy();
    expect(outer).toBeTruthy();
    expect(card).toBeTruthy();
    expect(title).toBeTruthy();

    mockRect(root!, {
      bottom: 720,
      height: 720,
      left: 0,
      right: 1280,
      top: 0,
      width: 1280,
    });
    mockRect(outer!, {
      bottom: 300,
      height: 180,
      left: 120,
      right: 1160,
      top: 120,
      width: 1040,
    });
    mockRect(card!, {
      bottom: 287,
      height: 154,
      left: 238,
      right: 998,
      top: 133,
      width: 760,
    });
    mockRect(title!, {
      bottom: 221,
      height: 52,
      left: 332,
      right: 904,
      top: 169,
      width: 572,
    });
    mockHitStack([card!, outer!, root!, document.body, document.documentElement]);

    const result = evaluateDesignerCapture({ x: 280, y: 196 });

    expect(result.target?.id).toBe("card");
    expect(result.targetRect).toEqual(
      expect.objectContaining({
        height: 154,
        width: 760,
      }),
    );
  });

  it("prefers a visible text block when the pointer is over text", () => {
    document.body.innerHTML = `
      <main id="root" style="position: relative; width: 1280px; height: 720px; background: #0f0f0f;">
        <section
          id="outer"
          style="
            display: flex;
            align-items: center;
            padding: 0 120px 0 36px;
            background: linear-gradient(180deg, rgba(20,24,36,0.55), rgba(20,24,36,0.22));
            border-radius: 28px;
          "
        >
          <div
            id="card"
            style="
              width: 760px;
              height: 154px;
              margin: 0 auto;
              border-radius: 24px;
              background: rgba(45, 51, 61, 0.96);
              box-shadow: 0 10px 30px rgba(0,0,0,0.35);
              display: flex;
              align-items: center;
              justify-content: center;
              color: white;
              font: 600 30px/1.2 sans-serif;
            "
          >
            <div id="title">
              <span id="copy">Try searching to get started</span>
            </div>
          </div>
        </section>
      </main>
    `;
    const root = document.getElementById("root");
    const outer = document.getElementById("outer");
    const card = document.getElementById("card");
    const title = document.getElementById("title");
    const copy = document.getElementById("copy");

    expect(root).toBeTruthy();
    expect(outer).toBeTruthy();
    expect(card).toBeTruthy();
    expect(title).toBeTruthy();
    expect(copy).toBeTruthy();

    mockRect(root!, {
      bottom: 720,
      height: 720,
      left: 0,
      right: 1280,
      top: 0,
      width: 1280,
    });
    mockRect(outer!, {
      bottom: 300,
      height: 180,
      left: 120,
      right: 1160,
      top: 120,
      width: 1040,
    });
    mockRect(card!, {
      bottom: 287,
      height: 154,
      left: 238,
      right: 998,
      top: 133,
      width: 760,
    });
    mockRect(title!, {
      bottom: 221,
      height: 52,
      left: 332,
      right: 904,
      top: 169,
      width: 572,
    });
    mockRect(copy!, {
      bottom: 212,
      height: 34,
      left: 392,
      right: 844,
      top: 178,
      width: 452,
    });
    mockHitStack([copy!, title!, card!, outer!, root!, document.body, document.documentElement]);

    const result = evaluateDesignerCapture({ x: 620, y: 196 });

    expect(result.target?.id).toBe("title");
    expect(result.targetRect).toEqual(
      expect.objectContaining({
        height: 52,
        width: 572,
      }),
    );
  });

  it("maps guest rects back into the host overlay coordinate space", () => {
    document.body.innerHTML = `
      <main id="root" style="position: relative; width: 1280px; height: 720px; background: #0f0f0f;">
        <section
          id="outer"
          style="
            display: flex;
            align-items: center;
            padding: 0 120px 0 36px;
            background: linear-gradient(180deg, rgba(20,24,36,0.55), rgba(20,24,36,0.22));
            border-radius: 28px;
          "
        >
          <div
            id="card"
            style="
              width: 760px;
              height: 154px;
              margin: 0 auto;
              border-radius: 24px;
              background: rgba(45, 51, 61, 0.96);
              box-shadow: 0 10px 30px rgba(0,0,0,0.35);
              display: flex;
              align-items: center;
              justify-content: center;
              color: white;
              font: 600 30px/1.2 sans-serif;
            "
          >
            <div id="title">Try searching to get started</div>
          </div>
        </section>
      </main>
    `;
    const root = document.getElementById("root");
    const outer = document.getElementById("outer");
    const card = document.getElementById("card");

    expect(root).toBeTruthy();
    expect(outer).toBeTruthy();
    expect(card).toBeTruthy();

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1280,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 720,
    });

    mockRect(root!, {
      bottom: 720,
      height: 720,
      left: 0,
      right: 1280,
      top: 0,
      width: 1280,
    });
    mockRect(outer!, {
      bottom: 300,
      height: 180,
      left: 120,
      right: 1160,
      top: 120,
      width: 1040,
    });
    mockRect(card!, {
      bottom: 287,
      height: 154,
      left: 238,
      right: 998,
      top: 133,
      width: 760,
    });

    const elementFromPointMock = vi.fn((x: number, y: number) => {
      expect(x).toBe(280);
      expect(y).toBe(196);
      return card!;
    });
    const elementsFromPointMock = vi.fn((x: number, y: number) => {
      expect(x).toBe(280);
      expect(y).toBe(196);
      return [card!, outer!, root!, document.body, document.documentElement];
    });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: elementFromPointMock,
    });
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: elementsFromPointMock,
    });

    const result = evaluateDesignerCapture(
      { x: 140, y: 98 },
      {
        width: 640,
        height: 360,
      },
    );

    expect(result.target?.id).toBe("card");
    expect(result.targetRect).toEqual({
      x: 119,
      y: 67,
      width: 380,
      height: 77,
    });
    expect(elementFromPointMock).toHaveBeenCalledOnce();
    expect(elementsFromPointMock).toHaveBeenCalledOnce();
  });
});
