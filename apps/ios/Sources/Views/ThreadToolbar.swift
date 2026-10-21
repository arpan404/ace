import SwiftUI

/// Everything the ⋯ menu opens: each destination is listed once.
enum ThreadDestination { case search, files, terminal, browser, devices, computer, tools }

/// The thread's header: its title with "project · branch" under it, then Changes, Agents and ⋯
/// sharing one glass capsule on iOS 26.
struct ThreadToolbar: ToolbarContent {
    let title: String
    let subtitle: String
    let status: String
    let openChanges: () -> Void
    let openAgents: () -> Void
    let menu: ThreadMenu

    var body: some ToolbarContent {
        if #unavailable(iOS 26) {
            ToolbarItem(placement: .principal) {
                VStack(spacing: AceTheme.Spacing.none) {
                    Text(title).aceFont(AceTheme.Typography.rowTitle, relativeTo: .headline).fontWeight(.bold).lineLimit(1)
                    if !subtitle.isEmpty {
                        Text(subtitle).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                            .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityValue(status)
            }
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
            Button("Changes", systemImage: "plusminus", action: openChanges)
                .accessibilityIdentifier("thread.changes")
            Button("Agents", systemImage: "point.3.connected.trianglepath.dotted", action: openAgents)
                .accessibilityIdentifier("thread.agents")
            menu
        }
    }
}

/// The ⋯ menu: the thread's other places and what can be done to it.
struct ThreadMenu: View {
    let model: ClientModel
    let thread: ThreadModel
    let archived: Bool
    /// The row a Lock Screen activity starts from; nil when there is none yet.
    let activityRow: ThreadRow?
    let open: (ThreadDestination) -> Void
    let problem: (String) -> Void
    /// Leaves the thread after it was snoozed or archived.
    let leave: () -> Void

    var body: some View {
        Menu {
            Section {
                Button("Find in thread", systemImage: "magnifyingglass") { open(.search) }.accessibilityIdentifier("thread.search")
                Button("Files", systemImage: "folder") { open(.files) }.accessibilityIdentifier("thread.files")
                Button("Terminal", systemImage: "apple.terminal") { open(.terminal) }.accessibilityIdentifier("thread.terminal")
                if model.threadHasBrowser {
                    Button("Browser", systemImage: "safari") { open(.browser) }.accessibilityIdentifier("thread.browser")
                }
                Button("Devices", systemImage: "iphone") { open(.devices) }.accessibilityIdentifier("thread.devices")
                Button("Computer use", systemImage: "macwindow") { open(.computer) }
                Button("Skills and tools", systemImage: "wrench.and.screwdriver") { open(.tools) }.accessibilityIdentifier("thread.tools")
            }
            Section {
                if let activityRow, let hostId = model.hostId {
                    Button("Show on Lock Screen", systemImage: "widget.small") {
                        do { try model.liveActivity.start(row: activityRow, hostId: hostId, online: model.connection == "ready") }
                        catch { problem(error.localizedDescription) }
                    }
                }
                if model.canOperate, !model.inboxLayout.snooze.isEmpty {
                    Menu("Snooze", systemImage: "moon.zzz") {
                        ForEach(model.inboxLayout.snooze) { option in
                            Button(option.label) { Task { if await model.snooze(thread.id, preset: option.id) { leave() } } }
                        }
                    }
                }
                if model.canOperate, !archived {
                    Button("Archive", systemImage: "archivebox") { Task { if await model.archive(thread.id) { leave() } } }
                }
            }
            if model.canOperate, thread.screen.controls?.canStop == true {
                Section {
                    Button("Stop all agents", systemImage: "stop.circle", role: .destructive) { model.stopTree() }
                        .disabled(thread.screen.stopping)
                }
            }
        } label: {
            Label("Thread options", systemImage: "ellipsis")
        }
        .accessibilityIdentifier("thread.menu")
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
