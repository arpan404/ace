import SwiftUI

/// Everything the ⋯ menu opens: each destination is listed once.
enum ThreadDestination {
    case changes, search, files, terminal, browser, devices, computer, tools, agents
    /// The side panel's tab this opens as on iPad; nil for what always opens over the thread.
    var panelTool: PanelTool? {
        switch self {
        case .changes: .changes
        case .files: .files
        case .terminal: .terminal
        case .browser: .browser
        case .agents: .agents
        case .search, .devices, .computer, .tools: nil
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
/// with a small "project · branch" line under it, then ⋯. Agents are secondary: the agent tree is one entry in ⋯, never its own control.
struct ThreadToolbar: ToolbarContent {
    let title: String
    /// "project · branch" (or the machine where there is no branch).
    let subtitle: String
    let status: StatusDisplay?
    let menu: ThreadMenu
    /// Nil where the panel has no room: a phone, a narrow window.
    var panel: PanelToggle? = nil

    var body: some ToolbarContent {
        if #available(iOS 26, *) {
            ToolbarItem(placement: .principal) { heading }.sharedBackgroundVisibility(.hidden)
            // ⋯ sits in the same glass circle as the system's back button across from it.
            ToolbarItem(placement: .topBarTrailing) { EquatableView(content: menu) }
        } else {
            ToolbarItem(placement: .principal) { heading }
            ToolbarItem(placement: .topBarTrailing) { EquatableView(content: menu) }
        }
        if let panel {
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: panel.toggle) { Image(systemName: "sidebar.right") }
                    .accessibilityLabel(panel.shown ? "Hide panel" : "Show panel")
                    .accessibilityIdentifier("thread.panel")
            }
        }
    }
    private var heading: some View {
        VStack(spacing: AceTheme.Spacing.none) {
            Text(title).aceFont(AceTheme.Typography.body, relativeTo: .headline).fontWeight(.semibold)
                .foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
            if !subtitle.isEmpty {
                Text(subtitle).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1).truncationMode(.middle)
            }
        }
        .frame(maxWidth: AceTheme.Dimensions.touchTarget * 5)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityValue(status?.label ?? "")
        .accessibilityIdentifier("thread.title")
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

    var body: some View {
        Menu {
            Section {
                Button("Changes", ace: .plusMinus) { open(.changes) }.accessibilityIdentifier("thread.changes")
                Button("Agent tree", ace: .treeStructure) { open(.agents) }.accessibilityIdentifier("thread.agents")
                Button("Find in thread", ace: .magnifyingGlass) { open(.search) }.accessibilityIdentifier("thread.search")
                Button("Files", ace: .folder) { open(.files) }.accessibilityIdentifier("thread.files")
                Button("Browser", ace: .compass) { open(.browser) }.accessibilityIdentifier("thread.browser")
                Button("Devices", ace: .deviceMobile) { open(.devices) }.accessibilityIdentifier("thread.devices")
                Button("Terminal", ace: .terminalWindow) { open(.terminal) }.accessibilityIdentifier("thread.terminal")
                Button("Computer use", ace: .appWindow) { open(.computer) }
                Button("Skills and tools", ace: .wrench) { open(.tools) }.accessibilityIdentifier("thread.tools")
            }
            Section {
                if model.canOperate, model.transfers.linked, !archived {
                    // Shown only while this machine links to another (ADR 0101).
                    let ready = model.transfers.thread(thread.id)?.canContinue == true
                    Button { model.continueOn(threadId: thread.id, title: title) } label: {
                        Label {
                            Text("Continue on…")
                            if !ready { Text("Available once the thread stops working") }
                        } icon: { Image(ace: .desktop) }
                    }
                    .disabled(!ready)
                    .accessibilityIdentifier("thread.continueOn")
                }
                if hasActivity, let hostId = model.hostId {
                    Button("Show on Lock Screen", ace: .squaresFour) {
                        guard let activityRow = activityRow() else { return }
                        do { try model.liveActivity.start(row: activityRow, hostId: hostId, online: model.connection == "ready") }
                        catch { problem(error.localizedDescription) }
                    }
                }
                if model.canOperate, !model.inboxLayout.snooze.isEmpty {
                    Menu {
                        ForEach(model.inboxLayout.snooze) { option in
                            Button(option.label) { Task { if await model.snooze(thread.id, preset: option.id) { leave() } } }
                        }
                    } label: { Label("Snooze", ace: .bellSimpleZ) }
                }
                if model.canOperate, !archived {
                    Button("Archive", ace: .archive) { Task { if await model.archive(thread.id) { leave() } } }
                }
            }
            if model.canOperate, thread.screen.controls?.canStop == true {
                Section {
                    // Stop isn't destructive: it reads in ink, never red.
                    Button("Stop all agents", ace: .stopCircle) { model.stopTree() }
                        .disabled(thread.screen.stopping)
                }
            }
        } label: {
            AceIcon(.dotsThree, size: 20)
                .foregroundStyle(AceTheme.Colours.foreground)
                .frame(width: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.sm, height: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.sm)
                .contentShape(Rectangle())
        }
        // On the menu itself: a label on its icon leaves the button VoiceOver reads unnamed.
        .accessibilityLabel("Thread options")
        .accessibilityIdentifier("thread.menu")
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
