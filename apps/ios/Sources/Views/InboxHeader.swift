import SwiftUI

/// The machines the inbox can't reach right now, as the header names them. Built from each
/// session's own connection state; the rows keep their own confirmation and never read fresh.
struct InboxConnectionProblem: Equatable {
    /// The machine's name when one is out, else how many.
    let text: String
    /// Still trying (spinner) rather than out of reach (wifi.slash).
    let trying: Bool
    /// `inbox.connection.<name>` when machines are named, for UI tests.
    let identifier: String

    @MainActor static func of(_ inbox: MachineInbox) -> InboxConnectionProblem? {
        let out = inbox.sessions.filter { $0.client.connection != "ready" }
        guard let first = out.first else { return nil }
        let trying = out.allSatisfy { ["connecting", "starting", "reconnecting"].contains($0.client.connection) }
        let named = inbox.showsMachineNames ? inbox.name(first.hostId) : "your machine"
        let subject = out.count > 1 ? "\(out.count) machines" : named
        let fatal = out.contains { $0.client.connection == "fatal" }
        let text = fatal ? "Can't reach \(subject)"
            : out.allSatisfy({ ["connecting", "starting"].contains($0.client.connection) }) ? "Connecting to \(subject)"
            : trying ? "Reconnecting to \(subject)"
            : out.count > 1 ? "\(subject) offline" : inbox.showsMachineNames ? "\(named) is offline" : "Your machine is offline"
        let identifier = inbox.showsMachineNames && out.count == 1 ? "inbox.connection.\(inbox.name(first.hostId))" : "inbox.connection"
        return InboxConnectionProblem(text: text, trying: trying && !fatal, identifier: identifier)
    }
}

/// The list's title in the bar's leading slot: "Threads ⌄" opening the scope menu (the Pulls tab's
/// title has none), and under it the scope, or what is wrong with the connection while it lasts.
struct InboxHeading: View {
    let title: String
    let filters: InboxFilters?
    let problem: InboxConnectionProblem?
    let openMachines: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let filters {
                Menu { filters } label: {
                    VStack(alignment: .leading, spacing: 0) {
                        heading(chevron: true)
                        if problem == nil { scope(filters.subtitle) }
                    }
                }
                .accessibilityIdentifier("inbox.projects")
                .accessibilityHint("Chooses the projects and machines listed")
            } else {
                heading(chevron: false)
            }
            InboxTitle(problem: problem, openMachines: openMachines)
        }
        .fixedSize()
    }

    private func scope(_ text: String) -> some View {
        Text(text).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1)
    }

    private func heading(chevron: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Text(title).aceFont(AceTheme.TypeStyle(size: 20, lineHeight: 24, weight: 700, tracking: -0.3), relativeTo: .title3)
                .foregroundStyle(AceTheme.Colours.foreground)
            if chevron {
                Image(systemName: "chevron.down").font(.system(size: 12, weight: .bold))
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
            }
        }
        .accessibilityAddTraits(.isHeader)
    }
}

/// What is wrong with the connection, once a problem has lasted 800ms, under the title; the
/// nothing while every machine is reachable. Tapping it opens Machines.
struct InboxTitle: View {
    let problem: InboxConnectionProblem?
    let openMachines: () -> Void
    @State private var shown: InboxConnectionProblem?

    var body: some View {
        Group {
            if let shown {
                Button(action: openMachines) {
                    HStack(spacing: AceTheme.Spacing.sm) {
                        if shown.trying { ProgressView().controlSize(.small) } else { Image(systemName: "wifi.slash") }
                        Text(shown.text).lineLimit(1)
                    }
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .fixedSize()
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine)
                .accessibilityHint("Opens Machines")
                .accessibilityIdentifier(shown.identifier)
            }
        }
        .task(id: problem) {
            guard let problem else { shown = nil; return }
            // An already-visible problem updates at once; a new one waits out a brief blip.
            if shown == nil { try? await Task.sleep(for: .milliseconds(800)) }
            if !Task.isCancelled { shown = problem }
        }
    }
}

/// The scope the Threads title's menu chooses: the machine (while more than one is paired), the
/// project, and how the machines sort threads. Each is a native picker with checkmarks.
struct InboxFilters: View {
    let inbox: MachineInbox
    @Binding var machine: String
    @Binding var project: String

    private struct Choice: Hashable { let id: String; let name: String }
    private var projects: [Choice] {
        var seen = Set<String>()
        return inbox.sessions.filter { machine.isEmpty || $0.hostId == machine }.flatMap { $0.client.inbox.values }.compactMap { row in
            // Each chat's hidden project is not a project to filter by (ADR 0099).
            guard let id = row.workspaceId, row.chat != true, seen.insert(id).inserted else { return nil }
            return Choice(id: id, name: row.project)
        }.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// The scope in words, under the title: "All projects", "ace", "Studio · ace".
    var subtitle: String {
        let projectName = projects.first { $0.id == project }?.name ?? "All projects"
        guard inbox.showsMachineNames else { return projectName }
        return "\(machine.isEmpty ? "All machines" : inbox.name(machine)) · \(projectName)"
    }

    var body: some View {
        if inbox.showsMachineNames {
            Picker("Machine", selection: $machine) {
                Text("All machines").tag("")
                ForEach(inbox.sessions) { Text(inbox.name($0.hostId)).tag($0.hostId) }
            }
        }
        Picker("Project", selection: $project) {
            Text("All projects").tag("")
            ForEach(projects, id: \.id) { Text($0.name).tag($0.id) }
        }
        sortPicker
    }

    /// Sort threads, the machines' own setting (the web's Settings › Agents › Sort threads), under
    /// the projects. Choosing saves it on every machine this phone can act on.
    @ViewBuilder private var sortPicker: some View {
        let choices = inbox.sortChoices
        if !choices.isEmpty && inbox.sessions.contains(where: { $0.client.canOperate }) {
            Section("Sort threads") {
                Picker("Sort threads", selection: Binding(
                    get: { inbox.sortBy(in: machine) ?? "activity" },
                    set: { choice in Task { await inbox.setSort(choice) } })) {
                    ForEach(choices) { Text($0.label).tag($0.id) }
                }
            }
            .accessibilityIdentifier("inbox.sort")
        }
    }
}

/// The inbox's glass chip: a menu's current choice and a chevron. The Pull requests and Issues
/// tab uses the same chips.
struct InboxChip: View {
    let title: String
    var body: some View {
        HStack(spacing: 6) {
            Text(title).lineLimit(1)
            Image(systemName: "chevron.down").font(.system(size: 11, weight: .semibold))
        }
        .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
        .foregroundStyle(AceTheme.Colours.mutedForeground)
        .padding(.horizontal, 14)
        .frame(minHeight: 36)
        .aceGlass(in: AceShape.capsule, interactive: true)
        .contentShape(AceShape.capsule)
    }
}

extension View {
    /// Pins `bar` under the navigation bar. On iOS 26 it joins the bar's scroll-edge effect, so
    /// rows pass under it; iOS 18 gives it the page colour.
    @ViewBuilder func inboxTopBar<Bar: View>(@ViewBuilder _ bar: () -> Bar) -> some View {
        if #available(iOS 26, *) {
            safeAreaBar(edge: .top, spacing: AceTheme.Spacing.none, content: bar)
        } else {
            safeAreaInset(edge: .top, spacing: AceTheme.Spacing.none) { bar().background(AceTheme.Colours.background) }
        }
    }
}
