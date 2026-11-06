import SwiftUI

/// Everything the ⋯ menu opens: each destination is listed once.
enum ThreadDestination {
    case work, changes, search, files, terminal, scripts, browser, devices, computer, tools, agents, logs
    case rename, forkLast, merge, turns, attachments
    /// The side panel's tab this opens as on iPad; nil for what always opens over the thread.
    var panelTool: PanelTool? {
        switch self {
        case .changes: .changes
        case .files: .files
        case .terminal: .terminal
        case .browser: .browser
        case .agents: .agents
        case .scripts: .preview
        case .work, .search, .devices, .computer, .tools, .logs,
             .rename, .forkLast, .merge, .turns, .attachments: nil
        }
    }
}

/// The thread bar's button that shows and hides the side panel (iPad, a wide window).
struct PanelToggle {
    let shown: Bool
    let toggle: () -> Void
}

/// The thread's header: the native back over a pushed page, or at the open thread's root the
/// sidebar button (beside the list) or the drawer's (a compact window, `ThreadDrawer`), the title
/// centred with the model and its effort under it, both one menu (`ThreadTitleMenu`), then ⋯.
/// Agents are secondary: the agent tree is one entry in ⋯, never its own control.
struct ThreadToolbar: ToolbarContent {
    /// The title and the line under it; its width is the toolbar's to give.
    let heading: ThreadTitleMenu
    let pageWidth: CGFloat
    let menu: ThreadMenu
    /// Nil where the panel has no room: a phone, a narrow window.
    var panel: PanelToggle? = nil
    var coveredByDrawer = false
    /// Buttons the page showing adds to the bar (a thread's Browser or Terminal page).
    var pageButtons = 0

    private var headingWidth: CGFloat {
        max(0, min(AceDesign.Size.tap * 5,
                   pageWidth - CGFloat((panel == nil ? 0 : 2) + 2 * max(1, pageButtons)) * AceDesign.Size.tap - 2 * AceDesign.Space.margin))
    }

    var body: some ToolbarContent {
        if #available(iOS 26, *) {
            ToolbarItem(placement: .principal) { title }.sharedBackgroundVisibility(.hidden)
            if pageButtons == 0 {
                ToolbarItem(placement: .topBarTrailing) { displayedMenu }
                    .sharedBackgroundVisibility(coveredByDrawer ? .hidden : .automatic)
            }
        } else {
            ToolbarItem(placement: .principal) { title }
            if pageButtons == 0 { ToolbarItem(placement: .topBarTrailing) { displayedMenu } }
        }
        if let panel {
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: panel.toggle) { Image(systemName: "sidebar.right") }
                    .accessibilityLabel(panel.shown ? "Hide panel" : "Show panel")
                    .accessibilityIdentifier("thread.panel")
            }
        }
    }
    private var title: some View {
        var heading = heading
        heading.width = headingWidth
        return EquatableView(content: heading).clipped()
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

/// The ⋯ menu: the thread's other places and what can be done to it. It redraws only when what
/// it shows changes (`==`): a menu rebuilt while open drops the item under the finger, and the
/// thread's row changes many times a second while it works.
struct ThreadMenu: View, Equatable {
    let model: ClientModel
    let thread: ThreadModel
    /// The thread's title, as Continue on… names it.
    var title = ""
    let archived: Bool
    let open: (ThreadDestination) -> Void
    /// Where `open` sends a tool now (the iPad side panel, or over the thread): it is part of
    /// what the menu is, so a change rebuilds the menu with a fresh `open`.
    var opensInPanel = false
    /// The thread's pages on a phone; nil beside the side panel.
    var pages: ThreadPages? = nil
    /// Leaves the thread after it was snoozed or archived.
    let leave: () -> Void
    @State private var showing = false

    var body: some View {
        Button {
            showing = true
        } label: {
            AceIcon(.dotsThree, size: AceDesign.Size.navGlyph, weight: .bold)
                .foregroundStyle(AceTheme.Colours.foreground)
                .contentShape(Rectangle())
        }
        .buttonBorderShape(.circle)
        // On the menu itself: a label on its icon leaves the button VoiceOver reads unnamed.
        .accessibilityLabel("Thread options")
        .accessibilityIdentifier("thread.menu")
        .popover(isPresented: $showing) {
            ThreadMenuPanel(model: model, thread: thread, title: title, archived: archived,
                            open: open, leave: leave, pages: pages)
                .presentationCompactAdaptation(.sheet)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    /// What the menu shows from its inputs; the model's own state it reads redraws it as it changes.
    nonisolated static func == (lhs: ThreadMenu, rhs: ThreadMenu) -> Bool {
        lhs.model === rhs.model && lhs.thread === rhs.thread && lhs.title == rhs.title
            && lhs.archived == rhs.archived && lhs.opensInPanel == rhs.opensInPanel
            && lhs.pages == rhs.pages
    }
}

extension View {
    /// The thread's title and its "project · branch" line, as the system draws them on iOS 26.
    @ViewBuilder func threadTitle(_ title: String, subtitle: String) -> some View {
        if #available(iOS 26, *) {
            navigationTitle(title).navigationSubtitle(subtitle)
        } else {
            navigationTitle(title)
        }
    }
}
