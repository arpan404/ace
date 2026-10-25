import SwiftUI

/// Message search across every paired machine: one `ConversationSearch` per machine, so each
/// machine's late replies only ever replace its own results.
@MainActor @Observable final class InboxMessageSearch {
    private(set) var searches: [String: ConversationSearch] = [:]

    func run(_ inbox: MachineInbox, text: String) async {
        let sessions = inbox.sessions
        for session in sessions where searches[session.hostId] == nil { searches[session.hostId] = ConversationSearch() }
        // Every machine searches at once; a newer query cancels them all.
        let runs = sessions.compactMap { session in
            searches[session.hostId].map { search in
                Task<Void, Never> { await search.search(model: session.client, text: text, kind: "message", threadId: nil) }
            }
        }
        await withTaskCancellationHandler {
            for run in runs { await run.value }
        } onCancel: {
            for run in runs { run.cancel() }
        }
    }
    func hits(_ hostId: String) -> [ConversationHit] { searches[hostId]?.hits ?? [] }
    var loading: Bool { searches.values.contains { $0.loading } }
    var settled: Bool { !searches.isEmpty && searches.values.allSatisfy { $0.loaded || $0.problem != nil } }
}

/// What the inbox's search finds: threads whose title, project or branch match, from the rows
/// already on the phone, then messages from each machine's conversation search.
struct InboxSearchList: View {
    @Bindable var inbox: MachineInbox
    let query: String
    let includes: (InboxKey) -> Bool
    let open: (InboxKey) -> Void
    @State private var messages = InboxMessageSearch()

    private var threads: [(key: InboxKey, row: ThreadRow)] {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return inbox.merged.sections.filter { $0.key != "unsent" }.flatMap(\.rows).filter(includes).compactMap { key in
            guard let row = inbox.row(key) else { return nil }
            let matches = [row.title, row.project, row.branch].contains { $0.localizedCaseInsensitiveContains(text) }
            return matches ? (key, row) : nil
        }
    }

    var body: some View {
        let threads = threads
        List {
            if !threads.isEmpty {
                Section {
                    ForEach(threads, id: \.key) { match in
                        Button { open(match.key) } label: {
                            InboxThreadRow(row: match.row, snoozed: false, machine: inbox.showsMachineNames ? inbox.name(match.key.machineId) : nil)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("search.thread.\(match.row.id)")
                        .inboxRowChrome()
                    }
                } header: { header("Threads") }
            }
            ForEach(inbox.sessions) { session in
                let hits = messages.hits(session.hostId)
                if !hits.isEmpty {
                    Section {
                        ForEach(hits) { hit in
                            // The thread opens at the hit, in its own history window.
                            Button {
                                if let itemId = hit.itemId { session.client.focusOnOpen = ThreadFocus(thread: hit.threadId, item: itemId) }
                                open(InboxKey(machineId: session.hostId, id: hit.threadId))
                            } label: { MessageHitLabel(hit: hit) }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("search.hit.\(hit.id)")
                            .inboxRowChrome()
                        }
                    } header: { header(inbox.showsMachineNames ? "Messages on \(inbox.name(session.hostId))" : "Messages") }
                }
            }
            if messages.loading {
                ProgressView().frame(maxWidth: .infinity).accessibilityLabel("Searching conversations")
                    .listRowSeparator(.hidden).listRowBackground(AceTheme.Colours.background)
            } else if threads.isEmpty && messages.settled && inbox.sessions.allSatisfy({ messages.hits($0.hostId).isEmpty }) {
                ContentUnavailableView.search(text: query)
                    .listRowSeparator(.hidden).listRowBackground(AceTheme.Colours.background)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(AceTheme.Colours.background)
        .environment(\.defaultMinListRowHeight, 0)
        .task(id: [query] + inbox.sessions.map { "\($0.hostId):\($0.client.connection)" }) {
            await messages.run(inbox, text: query)
        }
    }

    private func header(_ title: String) -> some View {
        Text(title).aceFont(AceTheme.Typography.label, relativeTo: .subheadline).textCase(nil)
            .foregroundStyle(AceTheme.Colours.subtleForeground)
    }
}

private struct MessageHitLabel: View {
    let hit: ConversationHit
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            Text(hit.threadTitle).aceFont(AceTheme.Typography.rowTitle, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
            Text(hit.excerpt).aceFont(AceTheme.Typography.body, relativeTo: .body).foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(2)
        }
        .padding(.vertical, AceTheme.Spacing.md)
        .accessibilityElement(children: .combine)
    }
}
