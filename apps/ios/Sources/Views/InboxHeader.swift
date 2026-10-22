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

/// The inbox's leading title: the ace wordmark, or, once a connection problem has lasted
/// 800ms, what is wrong in its place. Tapping the problem opens Machines.
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
                    .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .fixedSize()
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine)
                .accessibilityHint("Opens Machines")
                .accessibilityIdentifier(shown.identifier)
            } else {
                HStack(alignment: .center, spacing: 6) {
                    AceMark().frame(width: 22, height: 20)
                    Text("ace").aceFont(AceTheme.Typography.wordmark, relativeTo: .title3)
                }
                .foregroundStyle(AceTheme.Colours.foreground)
                .fixedSize()
                .accessibilityHidden(true)
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

/// "All machines ⌄" and "All projects ⌄" under the header, each a native menu with checkmarks.
/// The machine chip shows only while more than one machine is paired.
struct InboxFilters: View {
    let inbox: MachineInbox
    @Binding var machine: String
    @Binding var project: String

    private struct Choice: Hashable { let id: String; let name: String }
    private var projects: [Choice] {
        var seen = Set<String>()
        return inbox.sessions.filter { machine.isEmpty || $0.hostId == machine }.flatMap { $0.client.inbox.values }.compactMap { row in
            guard let id = row.workspaceId, seen.insert(id).inserted else { return nil }
            return Choice(id: id, name: row.project)
        }.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            if inbox.showsMachineNames {
                Menu {
                    Picker("Machine", selection: $machine) {
                        Text("All machines").tag("")
                        ForEach(inbox.sessions) { Text(inbox.name($0.hostId)).tag($0.hostId) }
                    }
                } label: { chip(machine.isEmpty ? "All machines" : inbox.name(machine)) }
                    .accessibilityIdentifier("inbox.machines.filter")
            }
            Menu {
                Picker("Project", selection: $project) {
                    Text("All projects").tag("")
                    ForEach(projects, id: \.id) { Text($0.name).tag($0.id) }
                }
            } label: { chip(projects.first { $0.id == project }?.name ?? "All projects") }
                .accessibilityIdentifier("inbox.projects")
            Spacer(minLength: AceTheme.Spacing.none)
        }
        .padding(.horizontal, 18)
        .padding(.bottom, AceTheme.Spacing.xs)
    }

    private func chip(_ title: String) -> some View { InboxChip(title: title) }
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
