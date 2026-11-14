import SwiftUI

/// History (the web's `/history`): every settled thread on every paired machine, newest first
/// under This week, Last week and Earlier. Each row opens its thread on the home screen. Older
/// settled threads the machines hold back page in from the foot.
struct HistoryView: View {
    let inbox: MachineInbox
    /// Opens a thread; `listed` false for one its machine's list doesn't hold yet.
    let open: (_ key: InboxKey, _ listed: Bool) -> Void
    @State private var history = HistoryList()

    var body: some View {
        let sections = HistoryMerge.sections(history.answers)
        List {
            ForEach(sections) { section in
                Section {
                    ForEach(section.rows) { row in
                        Button { open(row.key, row.thread.listed) } label: { HistoryRowView(row: row, machine: machineName(row)) }
                            .buttonStyle(.row)
                            .accessibilityIdentifier("history.\(row.thread.id)")
                            .inboxRowChrome()
                    }
                } header: { SearchHeader(section.label) }
            }
            foot(empty: sections.isEmpty)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .environment(\.defaultMinListRowHeight, 0)
        .background(AceTheme.Colours.background)
        .navigationTitle("History").navigationBarTitleDisplayMode(.inline)
        .task(id: readKey) { await history.run(inbox, query: "") }
    }

    /// Asked again when a machine connects or pages in more of its list.
    private var readKey: String {
        inbox.sessions.map { "\($0.hostId):\($0.client.connection):\($0.client.inbox.count)" }.joined(separator: "|")
    }
    private func machineName(_ row: HistoryRow) -> String? {
        inbox.showsMachineNames ? inbox.name(row.machineId) : nil
    }

    @ViewBuilder private func foot(empty: Bool) -> some View {
        if empty {
            switch history.phase {
            case .loading:
                SkeletonRows(count: 5, label: "Loading history")
            case .failed:
                EmptyState(icon: nil, title: "Couldn’t load history", line: "Check that a machine is connected.", failed: true) {
                    Button("Retry") { retry() }.accessibilityIdentifier("history.retry")
                }
                .padding(.vertical, AceDesign.Space.group)
            case .ready:
                EmptyState(icon: .clockCounterClockwise, title: "No settled threads yet",
                           line: "Threads you settle show here, newest first.")
                    .padding(.vertical, AceDesign.Space.group)
            }
        }
        if !inbox.merged.more.isEmpty {
            Button { for id in inbox.merged.more { inbox.client(id)?.loadOlderThreads() } } label: {
                Text("Show older threads").meta()
                    .frame(maxWidth: .infinity, minHeight: AceDesign.Size.tap, alignment: .leading)
            }
            .buttonStyle(.row)
            .accessibilityIdentifier("history.more")
        }
    }

    private func retry() {
        for session in inbox.sessions where session.client.connection != "ready" { session.client.retry() }
        Task { await history.run(inbox, query: "") }
    }
}

/// A settled thread: its title, then its project (and machine, with several) and when it last
/// worked, in the quiet ink.
private struct HistoryRowView: View {
    let row: HistoryRow
    let machine: String?
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.row) {
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                Text(row.thread.title.isEmpty ? "Untitled" : row.thread.title)
                    .aceFont(InboxRowType.title, relativeTo: .callout)
                    .foregroundStyle(AceTheme.Colours.foreground)
                    .lineLimit(1)
                if let place {
                    Text(place).meta(AceTheme.Colours.subtleForeground).lineLimit(1)
                }
            }
            Spacer(minLength: AceDesign.Space.related)
            Text(row.thread.date).meta(AceTheme.Colours.subtleForeground).monospacedDigit()
        }
        .padding(.horizontal, AceTheme.Spacing.rowInner)
        .padding(.vertical, AceDesign.Space.related)
        .frame(maxWidth: .infinity, minHeight: AceDesign.Size.tap, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
    private var place: String? {
        let parts = [machine, row.thread.project.isEmpty ? nil : row.thread.project].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
