import SwiftUI

/// Everything the ⋯ menu opens: each destination is listed once.
enum ThreadDestination {
    case work, changes, search, files, terminal, scripts, browser, devices, computer, tools, agents, logs, offshift
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
        case .work, .search, .devices, .computer, .tools, .logs, .offshift,
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
/// sidebar button (beside the list) or the drawer's (a compact window, `ThreadDrawer`), the title centred
/// with a small "project · branch" line under it (a button that opens Work), then ⋯. Agents are secondary: the agent tree is one entry in ⋯, never its own control.
struct ThreadToolbar: ToolbarContent {
    let title: String
    /// "project · branch" (or the machine where there is no branch).
    let subtitle: String
    let status: StatusDisplay?
    let pageWidth: CGFloat
    /// Rename and name-again from the title's own menu; nil where the thread can't be renamed.
    var rename: (() -> Void)? = nil
    var retitle: (() -> Void)? = nil
    let menu: ThreadMenu
    /// Opens the thread's Work sheet from the "project · branch" line.
    let openWork: () -> Void
    /// Nil where the panel has no room: a phone, a narrow window.
    var panel: PanelToggle? = nil
    var coveredByDrawer = false

    private var headingWidth: CGFloat {
        max(0, min(AceTheme.Dimensions.touchTarget * 5,
                   pageWidth - (panel == nil ? 2 : 4) * AceTheme.Dimensions.touchTarget - 2 * AceTheme.Spacing.lg))
    }

    var body: some ToolbarContent {
        if #available(iOS 26, *) {
            ToolbarItem(placement: .principal) { heading }.sharedBackgroundVisibility(.hidden)
            ToolbarItem(placement: .topBarTrailing) { displayedMenu }
                .sharedBackgroundVisibility(coveredByDrawer ? .hidden : .automatic)
        } else {
            ToolbarItem(placement: .principal) { heading }
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
    private var displayedMenu: some View {
        EquatableView(content: menu)
            .opacity(coveredByDrawer ? 0 : 1)
            .allowsHitTesting(!coveredByDrawer)
            .accessibilityHidden(coveredByDrawer)
    }
    /// The title opens its own menu, Rename first, as the system's documents do; a small chevron
    /// beside it says so. The "project · branch" line under it opens Work.
    private var heading: some View {
        VStack(spacing: AceTheme.Spacing.none) {
            titleRow
            if !subtitle.isEmpty {
                // The checkout's line opens Work: where the thread runs and what can move it.
                Button(action: openWork) {
                    Text(subtitle).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                        .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1).truncationMode(.middle)
                        .frame(width: headingWidth)
                        .frame(minHeight: AceTheme.Spacing.lg).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(subtitle)
                .accessibilityHint("Opens Work")
                .accessibilityIdentifier("thread.subtitle")
            }
        }
        // UIKit measures principal items at their ideal size. Reserve equal space
        // for the controls on either side before proposing a width to the text.
        .frame(width: headingWidth)
        .clipped()
        .accessibilityElement(children: .contain)
    }
    @ViewBuilder private var titleRow: some View {
        if let rename {
            Menu {
                Button("Rename…", ace: .pencilSimple, action: rename).accessibilityIdentifier("thread.rename")
                if let retitle { Button("Name from first message", ace: .sparkle, action: retitle).accessibilityIdentifier("thread.retitle") }
            } label: { titleText(chevron: true) }
            .accessibilityIdentifier("thread.title")
            .accessibilityHint("Rename this thread")
        } else {
            titleText(chevron: false).accessibilityIdentifier("thread.title")
        }
    }
    private func titleText(chevron: Bool) -> some View {
        HStack(spacing: AceTheme.Spacing.xxs) {
            Text(title).aceFont(AceTheme.Typography.body, relativeTo: .headline).fontWeight(.semibold)
                .foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
            if chevron {
                Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
                    .foregroundStyle(AceTheme.Colours.subtleForeground).accessibilityHidden(true)
            }
        }
        .frame(width: headingWidth)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityValue(status?.label ?? "")
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
    /// Whether the thread has a row to start a Lock Screen activity from.
    let hasActivity: Bool
    /// That row, read when the item is picked.
    let activityRow: () -> ThreadRow?
    let open: (ThreadDestination) -> Void
    /// Where `open` sends a tool now (the iPad side panel, or over the thread): it is part of
    /// what the menu is, so a change rebuilds the menu with a fresh `open`.
    var opensInPanel = false
    let problem: (String) -> Void
    /// Leaves the thread after it was snoozed or archived.
    let leave: () -> Void
    @State private var showing = false

    var body: some View {
        Button {
            showing = true
        } label: {
            AceIcon(.dotsThree, size: AceTheme.Spacing.xxl)
                .foregroundStyle(AceTheme.Colours.foreground)
                .contentShape(Rectangle())
        }
        .buttonBorderShape(.circle)
        // On the menu itself: a label on its icon leaves the button VoiceOver reads unnamed.
        .accessibilityLabel("Thread options")
        .accessibilityIdentifier("thread.menu")
        .popover(isPresented: $showing) {
            ThreadMenuPanel(model: model, thread: thread, title: title, archived: archived,
                            hasActivity: hasActivity, activityRow: activityRow, open: open,
                            problem: problem, leave: leave)
                .presentationCompactAdaptation(.sheet)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    /// What the menu shows from its inputs; the model's own state it reads redraws it as it changes.
    nonisolated static func == (lhs: ThreadMenu, rhs: ThreadMenu) -> Bool {
        lhs.model === rhs.model && lhs.thread === rhs.thread && lhs.title == rhs.title
            && lhs.archived == rhs.archived && lhs.hasActivity == rhs.hasActivity && lhs.opensInPanel == rhs.opensInPanel
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
