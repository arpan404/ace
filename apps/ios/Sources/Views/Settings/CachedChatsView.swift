import SwiftUI

/// What this phone keeps of each machine's chats (`bridge/chat-cache.ts`, ADR 0105): how many
/// threads and their size on disk, cleared per machine or all at once. Only cached reads go:
/// unsent messages and drafts stay, and open threads read again from their machine.
struct CachedChatsView: View {
    let inbox: MachineInbox
    @State private var clearingAll = false
    @State private var clearing: MachineSession?

    var body: some View {
        List {
            Section {
                InsetRow("Kept on this phone", systemImage: nil, value: summary(threads: total.threads, bytes: total.bytes))
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("cache.total")
            } footer: {
                Text("Chats are kept for 7 days after you last open them. Settled ones: only the 20 you opened last.")
            }
            .insetRowBackground()
            if inbox.sessions.count > 1 {
                Section {
                    ForEach(inbox.sessions) { session in
                        InsetRow(systemImage: nil, title: inbox.name(session.hostId), subtitle: usage(session)) {
                            Button("Clear", role: .destructive) { clearing = session }
                                .buttonStyle(.borderless)
                                .disabled(session.client.cacheUsage?.threads == 0)
                                .accessibilityIdentifier("cache.clear.\(session.hostId)")
                        }
                    }
                } header: { InsetHeader("Machines") }
                .insetRowBackground()
            }
            Section {
                Button("Clear cached chats", role: .destructive) { clearingAll = true }
                    .accessibilityIdentifier("cache.clearAll")
            } footer: {
                Text("Unsent messages and drafts stay. Open threads read again from their machine.")
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .navigationTitle("Cached chats").navigationBarTitleDisplayMode(.inline)
        .task { for session in inbox.sessions { session.client.readCache() } }
        .confirmationDialog("Clear cached chats?", isPresented: $clearingAll, titleVisibility: .visible) {
            Button("Clear cached chats", role: .destructive) {
                for session in inbox.sessions { session.client.clearCache() }
            }
            .accessibilityIdentifier("cache.clearAll.confirm")
        } message: { Text("This phone forgets the chats it keeps for every machine. Unsent messages and drafts stay.") }
        .confirmationDialog("Clear chats for \(clearing.map { inbox.name($0.hostId) } ?? "")?",
                            isPresented: Binding(get: { clearing != nil }, set: { if !$0 { clearing = nil } }),
                            titleVisibility: .visible) {
            Button("Clear", role: .destructive) { clearing?.client.clearCache(); clearing = nil }
                .accessibilityIdentifier("cache.clear.confirm")
        } message: { Text("Unsent messages and drafts stay.") }
    }

    private var total: (threads: Int, bytes: Int) {
        inbox.sessions.reduce((0, 0)) { sum, session in
            let usage = session.client.cacheUsage
            return (sum.0 + (usage?.threads ?? 0), sum.1 + (usage?.bytes ?? 0))
        }
    }
    private func usage(_ session: MachineSession) -> String {
        guard let usage = session.client.cacheUsage else { return "Reading…" }
        return summary(threads: usage.threads, bytes: usage.bytes)
    }
}

/// "12 chats · 3.4 MB", as the cache rows read.
private func summary(threads: Int, bytes: Int) -> String {
    let chats = threads == 1 ? "1 chat" : "\(threads) chats"
    return "\(chats) · \(ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file))"
}
