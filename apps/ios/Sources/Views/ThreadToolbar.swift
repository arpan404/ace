import SwiftUI

/// Everything the ⋯ menu opens: each destination is listed once.
enum ThreadDestination {
    case work, changes, search, files, terminal, scripts, browser, devices, computer, tools, agents, summary, logs
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

/// The thread's pages as its bar shows them on a phone: Chat and Changes beside ⋯, only when the
/// thread has Changes.
struct ThreadPageSwitch {
    let pages: ThreadPages
    let shown: ThreadPageKind
    let select: (ThreadPageKind) -> Void
    /// It shows only when there is a page to switch to.
    var shows: Bool { pages.kinds.count > 1 }
    /// The width it takes in the bar: a glyph per page and the glass's inset around them.
    var width: CGFloat { shows ? CGFloat(pages.kinds.count) * (AceDesign.Size.pill + 2) + AceDesign.Space.related : 0 }
}

/// The thread's header: the native back over a pushed page, or at the open thread's root the
/// sidebar button (beside the list) or the drawer's (a compact window, `ThreadDrawer`), the title
/// with the model and its effort under it, both one menu (`ThreadTitleMenu`), then on a phone with
/// changes Chat and Changes, then ⋯, one glass group. In a compact width the title leads, beside
/// the back button, as the system's own apps place it next to trailing buttons, so it gets every
/// point between the two; in a regular width it is centred. The thread's other screens
/// (Files, Terminal, Browser, Agents) are entries in ⋯, never their own controls.
struct ThreadToolbar: ToolbarContent {
    /// The title and the line under it; its width is the toolbar's to give.
    let heading: ThreadTitleMenu
    let pageWidth: CGFloat
    let menu: ThreadMenu
    /// Nil where the panel has no room: a phone, a narrow window.
    var panel: PanelToggle? = nil
    var coveredByDrawer = false
    /// Chat and Changes beside ⋯ (a phone); nil beside the side panel.
    var pages: ThreadPageSwitch? = nil
    /// A compact width: the title leads, beside the back button, instead of being centred.
    var leadingTitle = false

    /// The trailing buttons' width: ⋯, the page switch with the inset of the glass that groups
    /// it with ⋯, and the panel's toggle.
    private var trailingWidth: CGFloat {
        let switchWidth = pages.map { $0.shows ? $0.width + AceDesign.Space.related : 0 } ?? 0
        return CGFloat(1 + (panel == nil ? 0 : 1)) * AceDesign.Size.tap + switchWidth
    }
    /// Leading, the title takes everything between the one leading button and the trailing
    /// buttons, a gap from each. Centred, it gets the width between the wider side's buttons,
    /// mirrored, and no more than five buttons' worth.
    private var headingWidth: CGFloat {
        let margins = 2 * AceDesign.Space.margin
        if leadingTitle {
            // The bar insets a leading item from the back button and from the trailing group;
            // wider, it folds the trailing buttons into its own overflow menu.
            return max(0, pageWidth - margins - AceDesign.Size.tap - trailingWidth - 4 * AceDesign.Space.related)
        }
        return max(0, min(AceDesign.Size.tap * 5, pageWidth - 2 * trailingWidth - margins))
    }

    var body: some ToolbarContent {
        if #available(iOS 26, *) {
            if leadingTitle {
                ToolbarItem(placement: .topBarLeading) { title }.sharedBackgroundVisibility(.hidden)
            } else {
                ToolbarItem(placement: .principal) { title }.sharedBackgroundVisibility(.hidden)
            }
            // The page buttons and ⋯ share one glass background, as grouped bar buttons do.
            if let pages, pages.shows {
                ToolbarItem(placement: .topBarTrailing) { pageButtons(pages) }
                    .sharedBackgroundVisibility(coveredByDrawer ? .hidden : .automatic)
            }
            ToolbarItem(placement: .topBarTrailing) { displayedMenu }
                .sharedBackgroundVisibility(coveredByDrawer ? .hidden : .automatic)
        } else {
            ToolbarItem(placement: leadingTitle ? .topBarLeading : .principal) { title }
            if let pages, pages.shows {
                ToolbarItem(placement: .topBarTrailing) { pageButtons(pages) }
            }
            ToolbarItem(placement: .topBarTrailing) { displayedMenu }
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
        heading.leading = leadingTitle
        return EquatableView(content: heading).clipped()
    }
    private func pageButtons(_ pages: ThreadPageSwitch) -> some View {
        ThreadPageButtons(pages: pages.pages, shown: pages.shown, select: pages.select)
            .opacity(coveredByDrawer ? 0 : 1)
            .allowsHitTesting(!coveredByDrawer)
            .accessibilityHidden(coveredByDrawer)
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
