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

/// The thread's pages as its bar shows them on a phone: Chat and Changes beside ⋯, only when the
/// thread has Changes.
struct ThreadPageSwitch {
    let pages: ThreadPages
    let shown: ThreadPageKind
    let select: (ThreadPageKind) -> Void
    /// It shows only when there is a page to switch to.
    var shows: Bool { pages.kinds.count > 1 }
}

/// The thread's header: the native back over a pushed page, or at the open thread's root the
/// sidebar button (beside the list) or the drawer's (a compact window, `ThreadDrawer`), the title
/// with the model and its effort under it, both one menu (`ThreadTitleMenu`), then on a phone with
/// changes Chat and Changes, then ⋯, one glass group. In a compact width the title leads, beside
/// the back button, as the system's own apps place it next to trailing buttons: it is the bar's
/// title view, as wide as the room between the two and its words at its leading edge. In a
/// regular width it is centred. The thread's other screens
/// (Files, Terminal, Browser, Agents) are entries in ⋯, never their own controls.
struct ThreadToolbar: ToolbarContent {
    /// The title and the line under it; its width is the toolbar's to give.
    let heading: ThreadTitleMenu
    /// How the bar shares its width: the title's, and whether Chat and Changes fit beside ⋯.
    let layout: ThreadBarLayout
    let menu: ThreadMenu
    /// Nil where the panel has no room: a phone, a narrow window.
    var panel: PanelToggle? = nil
    var coveredByDrawer = false
    /// Chat and Changes beside ⋯ (a phone); nil beside the side panel.
    var pages: ThreadPageSwitch? = nil
    /// A compact width: the title leads, beside the back button, instead of being centred.
    var leadingTitle = false

    /// The page switch when it has a place in the bar; otherwise its pages are in ⋯.
    private var shownSwitch: ThreadPageSwitch? {
        guard let pages, pages.shows, layout.switchInBar else { return nil }
        return pages
    }

    var body: some ToolbarContent {
        if #available(iOS 26, *) {
            // Always the bar's title view, never a leading bar item: UIKit folds bar items that
            // don't fit, the title among them, into "More", taking ⋯ with them (#2023). It
            // fits the title view into the room the bar's buttons leave instead.
            ToolbarItem(placement: .principal) { title }.sharedBackgroundVisibility(.hidden)
            // The page buttons and ⋯ share one glass background, as grouped bar buttons do.
            if let pages = shownSwitch {
                ToolbarItemGroup(placement: .topBarTrailing) { pageButtons(pages) }
                    .sharedBackgroundVisibility(coveredByDrawer ? .hidden : .automatic)
            }
            ToolbarItem(placement: .topBarTrailing) { displayedMenu }
                .sharedBackgroundVisibility(coveredByDrawer ? .hidden : .automatic)
        } else {
            ToolbarItem(placement: .principal) { title }
            if let pages = shownSwitch {
                ToolbarItemGroup(placement: .topBarTrailing) { pageButtons(pages) }
            }
            ToolbarItem(placement: .topBarTrailing) { displayedMenu }
        }
        if let panel {
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: panel.toggle) { Image(systemName: "sidebar.right") }
                    .barGlyph()
                    .accessibilityShowsLargeContentViewer {
                        Image(systemName: "sidebar.right")
                        Text(panel.shown ? "Hide panel" : "Show panel")
                    }
                    .accessibilityLabel(panel.shown ? "Hide panel" : "Show panel")
                    .accessibilityIdentifier("thread.panel")
            }
        }
    }
    private var title: some View {
        var heading = heading
        heading.width = layout.headingWidth
        heading.leading = leadingTitle
        return EquatableView(content: heading).clipped()
    }
    private func pageButtons(_ pages: ThreadPageSwitch) -> some View {
        ThreadPageButtons(pages: pages.pages, shown: pages.shown, select: pages.select, hidden: coveredByDrawer)
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
    /// The page showing, and whether Chat and Changes are in the bar; when they aren't, ⋯ offers
    /// the page not showing.
    var shownPage: ThreadPageKind = .chat
    var switchInBar = true
    /// Leaves the thread after it was snoozed or archived.
    let leave: () -> Void
    @State private var showing = false
    /// The item picked, opened once the menu has gone: a sheet asked for while the menu's own
    /// sheet is still leaving is dropped without a word.
    @State private var picked: ThreadDestination?

    var body: some View {
        Button {
            showing = true
        } label: {
            // A plain glyph, so iOS draws the bar button at its own size; only the glyph keeps the
            // default size: the panel ⋯ presents keeps the person's text size.
            Image(ace: .dotsThree, weight: .bold)
                .foregroundStyle(AceTheme.Colours.foreground)
        }
        .barGlyph()
        .accessibilityShowsLargeContentViewer {
            Image(ace: .dotsThree, weight: .bold)
            Text("Thread options")
        }
        // On the menu itself: a label on its icon leaves the button VoiceOver reads unnamed.
        .accessibilityLabel("Thread options")
        .accessibilityIdentifier("thread.menu")
        .popover(isPresented: $showing) {
            ThreadMenuPanel(model: model, thread: thread, title: title, archived: archived,
                            open: { picked = $0 }, leave: leave, pages: pages, shownPage: shownPage,
                            switchInBar: switchInBar)
                .onDisappear {
                    guard let destination = picked else { return }
                    picked = nil
                    open(destination)
                }
                .presentationCompactAdaptation(.sheet)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    /// What the menu shows from its inputs; the model's own state it reads redraws it as it changes.
    nonisolated static func == (lhs: ThreadMenu, rhs: ThreadMenu) -> Bool {
        lhs.model === rhs.model && lhs.thread === rhs.thread && lhs.title == rhs.title
            && lhs.archived == rhs.archived && lhs.opensInPanel == rhs.opensInPanel
            && lhs.pages == rhs.pages && lhs.shownPage == rhs.shownPage && lhs.switchInBar == rhs.switchInBar
    }
}

extension View {
    /// A bar button's glyph at its default size whatever the text size, as the system's bar
    /// buttons are: a glyph grown with the text widens the bar's trailing group past the room the
    /// title leaves it (`ThreadBarLayout`), and UIKit folds the group into "More". Large text
    /// shows the button in the Large Content Viewer on a long press instead.
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
