import SwiftUI

/// One of the thread's screens in the ⋯ panel's icon grid.
private struct MenuScreen: Identifiable {
    let id: String
    let title: String
    let icon: AceIcon.Name
    let destination: ThreadDestination
    var identifier: String { id }
}

/// The ⋯ panel's icon grid: the thread's screens (Changes, Agent tree, Files, Terminal,
/// Browser, Logs, Find, Turns) as icons, so the menu fits without scrolling.
private struct MenuScreenGrid: View {
    let open: (ThreadDestination) -> Void
    let dismiss: DismissAction
    @Environment(\.dynamicTypeSize) private var typeSize

    private var screens: [MenuScreen] {
        [
            MenuScreen(id: "thread.changes", title: "Changes", icon: .plusMinus, destination: .changes),
            MenuScreen(id: "thread.agents", title: "Agent tree", icon: .treeStructure, destination: .agents),
            MenuScreen(id: "thread.files", title: "Files", icon: .folder, destination: .files),
            MenuScreen(id: "thread.terminal", title: "Terminal", icon: .terminalWindow, destination: .terminal),
            MenuScreen(id: "thread.browser", title: "Browser", icon: .compass, destination: .browser),
            MenuScreen(id: "thread.logs", title: "Logs", icon: .scroll, destination: .logs),
            MenuScreen(id: "thread.search", title: "Find", icon: .magnifyingGlass, destination: .search),
            MenuScreen(id: "thread.turns", title: "Turns", icon: .listBullets, destination: .turns),
        ]
    }

    var body: some View {
        // Large text gets two columns so labels never clip; otherwise four across.
        let columns = Array(repeating: GridItem(.flexible(), spacing: AceTheme.Spacing.xs),
                            count: typeSize.isAccessibilitySize ? 2 : 4)
        LazyVGrid(columns: columns, spacing: AceTheme.Spacing.sm) {
            ForEach(screens) { screen in
                Button {
                    open(screen.destination)
                    dismiss()
                } label: {
                    VStack(spacing: AceTheme.Spacing.xxs) {
                        AceIcon(screen.icon, size: 20, relativeTo: .body)
                            .foregroundStyle(AceTheme.Colours.foreground)
                            .frame(height: AceTheme.Spacing.xl)
                        Text(screen.title)
                            .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                            .foregroundStyle(AceTheme.Colours.foreground)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, minHeight: AceTheme.Dimensions.touchTarget)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(screen.id == "thread.search" ? "Find in thread" : screen.title)
                .accessibilityIdentifier(screen.id)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Open a screen")
    }
}

/// One compact row in the ⋯ panel's action sections.
private struct MenuRow: View {
    let title: String
    let icon: AceIcon.Name
    var identifier: String? = nil
    var role: ButtonRole? = nil
    let action: () -> Void
    var body: some View {
        Button(role: role, action: action) {
            Label(title, ace: icon)
                .aceFont(AceTheme.Typography.body, relativeTo: .body)
                .foregroundStyle(role == .destructive ? Color.red : AceTheme.Colours.foreground)
                .frame(maxWidth: .infinity, alignment: .leading)
                .frame(minHeight: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.sm)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier ?? title)
    }
}

/// The thread's ⋯ as a compact panel: an icon grid for its screens, then short action
/// sections. The native Menu's ~30 rows scrolled on a phone; this fits an iPhone 16 Pro Max
/// without scrolling at the default text size (a ScrollView only matters for large text).
struct ThreadMenuPanel: View {
    let model: ClientModel
    let thread: ThreadModel
    var title = ""
    let archived: Bool
    let hasActivity: Bool
    let activityRow: () -> ThreadRow?
    let open: (ThreadDestination) -> Void
    let problem: (String) -> Void
    let leave: () -> Void
    @Environment(\.threadOrganizer) private var organizer
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize
    private var row: ThreadRow? { model.inbox[thread.id] }
    private func leaving(_ organizer: ThreadOrganizer) -> ThreadOrganizer {
        ThreadOrganizer(perform: { key, id in
                            organizer.perform(key, id)
                            if id == "archive" { leave() }
                        },
                        snooze: { key, preset in organizer.snooze(key, preset); leave() },
                        wake: organizer.wake)
    }

    var body: some View {
        // Default text: a plain stack that sizes to its content, so the panel fits without
        // scrolling. Large text scrolls instead of clipping.
        Group {
            if typeSize.isAccessibilitySize {
                ScrollView { panel }
            } else {
                panel
            }
        }
        .frame(idealWidth: 340, maxWidth: 380)
        .accessibilityLabel("Thread options")
    }

    private var panel: some View {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                MenuScreenGrid(open: open, dismiss: dismiss)
                    .padding(.bottom, AceTheme.Spacing.sm)
                if let run = thread.screen.offshift {
                    Divider()
                    MenuRow(title: "Offshift run · \(run.word)", icon: .listChecks, identifier: "thread.offshift") {
                        open(.offshift); dismiss()
                    }
                }
                if model.canOperate, !archived {
                    Divider()
                    conversation
                }
                Divider()
                tools
                if let organizer, let row, let hostId = model.hostId, model.canOperate {
                    Divider()
                    // The row's shared actions, in the shared words (`threadMenu`).
                    ThreadActionItems(key: InboxKey(machineId: hostId, id: thread.id), row: row,
                                      labels: model.inboxLayout.menuLabels ?? [:],
                                      sections: model.inboxLayout.menuSections ?? [:],
                                      snoozeOptions: model.inboxLayout.snooze,
                                      organizer: dismissing(leaving(organizer)))
                }
                Divider()
                system
                if model.canOperate, thread.screen.controls?.canStop == true {
                    Divider()
                    MenuRow(title: "Stop all agents", icon: .stopCircle) {
                        model.stopTree(); dismiss()
                    }
                    .disabled(thread.screen.stopping)
                }
            }
            .padding(.horizontal, AceTheme.Spacing.lg)
            .padding(.vertical, AceTheme.Spacing.md)
    }

    /// What can be done with the conversation itself.
    @ViewBuilder private var conversation: some View {
        if model.canOperate, !archived {
            MenuRow(title: "Rename…", icon: .pencilSimple, identifier: "thread.menu.rename") {
                open(.rename); dismiss()
            }
            if thread.screen.transitions?.lastTurn == true {
                MenuRow(title: "Fork from the last turn", icon: .gitFork, identifier: "thread.forkLast") {
                    open(.forkLast); dismiss()
                }
            }
            if thread.screen.transitions?.parent != nil {
                MenuRow(title: "Bring back to parent…", icon: .gitMerge, identifier: "thread.merge") {
                    open(.merge); dismiss()
                }
            }
        }
    }

    /// The thread's tools that aren't screens: what the phone keeps, runs and opens elsewhere.
    @ViewBuilder private var tools: some View {
        MenuRow(title: "Reload from machine", icon: .arrowClockwise, identifier: "thread.reload") {
            model.reloadFromMachine(); dismiss()
        }
        MenuRow(title: "Run and preview…", icon: .play, identifier: "thread.scripts") {
            open(.scripts); dismiss()
        }
        MenuRow(title: "Work", icon: .gitBranch, identifier: "thread.work") {
            open(.work); dismiss()
        }
        MenuRow(title: "Attachments", icon: .paperclip, identifier: "thread.attachments") {
            open(.attachments); dismiss()
        }
        MenuRow(title: "Devices", icon: .deviceMobile, identifier: "thread.devices") {
            open(.devices); dismiss()
        }
        MenuRow(title: "Computer use", icon: .appWindow, identifier: "thread.computer") {
            open(.computer); dismiss()
        }
        MenuRow(title: "Skills and tools", icon: .wrench, identifier: "thread.tools") {
            open(.tools); dismiss()
        }
        OpenOnHostMenu(model: model, target: HostOpenTarget(threadId: thread.id)) {
            Label("Open in…", ace: .arrowSquareOut)
                .aceFont(AceTheme.Typography.body, relativeTo: .body)
                .foregroundStyle(AceTheme.Colours.foreground)
                .frame(maxWidth: .infinity, alignment: .leading)
                .frame(minHeight: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.sm)
                .contentShape(Rectangle())
        }
        .accessibilityIdentifier("thread.openIn")
    }

    /// Continue on, Lock Screen, and the organize fallbacks when no row is held.
    @ViewBuilder private var system: some View {
        if model.canOperate, model.transfers.linked, !archived {
            let ready = model.transfers.thread(thread.id)?.canContinue == true
            Button {
                model.continueOn(threadId: thread.id, title: title); dismiss()
            } label: {
                Label {
                    Text("Continue on…")
                    if !ready { Text("Available once the thread stops working") }
                } icon: { Image(ace: .desktop) }
            }
            .disabled(!ready)
            .accessibilityIdentifier("thread.continueOn")
            .frame(maxWidth: .infinity, alignment: .leading)
            .frame(minHeight: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.sm)
        }
        if hasActivity, let hostId = model.hostId {
            MenuRow(title: "Show on Lock Screen", icon: .squaresFour) {
                guard let activityRow = activityRow() else { return }
                do { try model.liveActivity.start(row: activityRow, hostId: hostId, online: model.connection == "ready") }
                catch { problem(error.localizedDescription) }
                dismiss()
            }
        }
        if organizer == nil || row == nil {
            if model.canOperate, !model.inboxLayout.snooze.isEmpty {
                Menu {
                    ForEach(model.inboxLayout.snooze) { option in
                        Button(option.label) {
                            Task { if await model.snooze(thread.id, preset: option.id) { leave() } }
                            dismiss()
                        }
                    }
                } label: {
                    Label("Snooze", ace: .bellSimpleZ)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .frame(minHeight: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.sm)
                        .contentShape(Rectangle())
                }
            }
            if model.canOperate, !archived {
                MenuRow(title: "Archive", icon: .archive) {
                    Task { if await model.archive(thread.id) { leave() } }
                    dismiss()
                }
            }
        }
    }

    /// Organize actions dismiss the panel after they run, as a Menu does.
    private func dismissing(_ organizer: ThreadOrganizer) -> ThreadOrganizer {
        let dismiss = dismiss
        return ThreadOrganizer(perform: { key, id in organizer.perform(key, id); dismiss() },
                               snooze: { key, preset in organizer.snooze(key, preset); dismiss() },
                               wake: { organizer.wake($0); dismiss() })
    }
}
