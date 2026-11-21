import SwiftUI

/// Everything the ⋯ menu opens: each destination is listed once.
enum ThreadDestination {
    case chat, work, changes, search, files, terminal, scripts, browser, devices, computer, tools, agents, summary, logs
    case rename, forkLast, merge, turns, attachments
    /// The side panel's tab this opens as on iPad; nil for what always opens over the thread.
    var panelTool: PanelTool? {
        switch self {
        case .changes: .changes
        case .files: .files
        case .terminal: .terminal
        case .browser: .browser
        case .agents: .agents
        case .summary: .summary
        case .scripts: .preview
        case .chat, .work, .search, .devices, .computer, .tools, .logs,
             .rename, .forkLast, .merge, .turns, .attachments: nil
        }
    }
}

/// The thread bar's button that shows and hides the side panel (iPad, a wide window).
struct PanelToggle {
    let shown: Bool
    let toggle: () -> Void
}

/// The thread's bar: the native back over a pushed page, or at the open thread's root the
/// sidebar button (beside the list) or the drawer's (a compact window, `ThreadDrawer`); the
/// system's title with the project and model under it and its menu (`ThreadTitleMenu`, set by
/// the thread's view); then ⋯ (`ThreadMenu`), and beside the iPad's side panel its toggle. The
/// thread's pages and screens (Chat, Changes, Files, Terminal, Browser, Agents) are in ⋯, never
/// their own bar buttons, so the title keeps the bar's width.
struct ThreadToolbar: ToolbarContent {
    let menu: ThreadMenu
    /// Nil where the panel has no room: a phone, a narrow window.
    var panel: PanelToggle? = nil
    var coveredByDrawer = false

    var body: some ToolbarContent {
        if #available(iOS 26, *) {
            ToolbarItem(placement: .topBarTrailing) { displayedMenu }
                .sharedBackgroundVisibility(coveredByDrawer ? .hidden : .automatic)
        } else {
            ToolbarItem(placement: .topBarTrailing) { displayedMenu }
        }
        if let panel {
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: panel.toggle) { Image(ace: .sidebarRight) }
                    .barGlyph()
                    .accessibilityShowsLargeContentViewer {
                        Image(ace: .sidebarRight)
                        Text(panel.shown ? "Hide panel" : "Show panel")
                    }
                    .accessibilityLabel(panel.shown ? "Hide panel" : "Show panel")
                    .accessibilityIdentifier("thread.panel")
            }
        }
    }
    private var displayedMenu: some View {
        EquatableView(content: menu)
            .opacity(coveredByDrawer ? 0 : 1)
            .allowsHitTesting(!coveredByDrawer)
            .accessibilityHidden(coveredByDrawer)
    }
}

/// What the title's menu offers beyond its name, each nil where it can't be done now.
struct ThreadTitleActions: Equatable {
    struct Settle { let label: String; let settled: Bool; let run: () -> Void }
    var fork: (() -> Void)? = nil
    var copyLink: (() -> Void)? = nil
    var settle: Settle? = nil
    var isEmpty: Bool { fork == nil && copyLink == nil && settle == nil }
    /// The same actions offered under the same words; what they run is not compared.
    nonisolated static func == (lhs: ThreadTitleActions, rhs: ThreadTitleActions) -> Bool {
        (lhs.fork == nil) == (rhs.fork == nil) && (lhs.copyLink == nil) == (rhs.copyLink == nil)
            && lhs.settle?.label == rhs.settle?.label && lhs.settle?.settled == rhs.settle?.settled
    }
}

extension View {
    /// A bar button's glyph at its default size whatever the text size, as the system's bar
    /// buttons are: a glyph grown with the text widens the bar's trailing group, and UIKit folds
    /// the group into "More" (#2023). Large text shows the button in the Large Content Viewer on
    /// a long press instead.
    func barGlyph() -> some View {
        dynamicTypeSize(...DynamicTypeSize.large)
    }

    /// The thread's title and its "project · branch" line, as the system draws them on iOS 26.
    @ViewBuilder func threadTitle(_ title: String, subtitle: String) -> some View {
        if #available(iOS 26, *) {
            navigationTitle(title).navigationSubtitle(subtitle)
        } else {
            navigationTitle(title)
        }
    }
}

extension Image {
    /// One of ace's icons as a navigation bar button's glyph, at a bar symbol's size: a bar button
    /// draws its image at the image's own size, so the size is the asset's (`bar-<name>`, written
    /// by `generate-icons.ts` for the names in `barIcons`).
    init(bar name: AceIcon.Name, weight: AceIcon.Weight = .regular) {
        self.init(weight == .bold ? "bar-\(name.rawValue)-bold" : "bar-\(name.rawValue)")
    }
}
