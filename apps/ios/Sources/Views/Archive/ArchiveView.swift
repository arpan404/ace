import SwiftUI

/// Settings › Archived: archived threads, one machine at a time (the web's Archived screen): most
/// recently archived first, 20 per page from the SDK's archive window. A thread opens read-only
/// in Settings' stack; Unarchive returns it to the inbox. Settings closes the window it follows
/// once the archive and its threads are gone.
struct ArchiveView: View {
    let inbox: MachineInbox
    /// The machine whose archive window is open; Settings owns it so an open thread keeps it.
    @Binding var following: String?
    let open: (_ machine: String, _ id: String) -> Void
    @State private var machineId: String

    init(inbox: MachineInbox, following: Binding<String?>, open: @escaping (_ machine: String, _ id: String) -> Void) {
        self.inbox = inbox
        _following = following
        self.open = open
        _machineId = State(initialValue: following.wrappedValue ?? inbox.sessions.first?.hostId ?? "")
    }
    private var client: ClientModel? { inbox.client(machineId) }

    var body: some View {
        List {
            if inbox.sessions.count > 1 {
                Picker("Machine", selection: $machineId) {
                    ForEach(inbox.sessions) { session in Text(inbox.name(session.hostId)).tag(session.hostId) }
                }
                .accessibilityIdentifier("archive.machine")
            }
            if let client { ArchiveRows(client: client) { open(machineId, $0) }.listRowBackground(Color.clear) }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(AceTheme.Colours.background)
        .navigationTitle("Archived").navigationBarTitleDisplayMode(.inline)
        .task(id: machineId) { follow(machineId) }
    }
    /// Only one machine's archive window is open at a time; the others stay on their home window.
    private func follow(_ hostId: String) {
        guard following != hostId else { return }
        if let following { inbox.client(following)?.closeArchive() }
        following = hostId
        inbox.client(hostId)?.openArchive()
    }
}

/// The list itself: rows from the inbox rows the bridge already sends, in the archive's order.
private struct ArchiveRows: View {
    @Bindable var client: ClientModel
    let open: (String) -> Void
    private var archive: ArchiveBrowserModel { client.archive }

    var body: some View {
        let ids = archive.list.ids.filter { client.inbox[$0] != nil }
        ForEach(ids, id: \.self) { id in
            if let row = client.inbox[id] {
                Button { open(id) } label: { InboxThreadRow(row: row, snoozed: false) }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("archive.\(id)")
                    .accessibilityHint("Opens read-only")
                    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                        if client.canOperate {
                            Button("Unarchive", systemImage: "tray.and.arrow.up") { Task { _ = await client.unarchive(id) } }
                                .tint(AceTheme.Colours.mutedForeground)
                        }
                    }
                    .contextMenu {
                        if client.canOperate {
                            Button("Unarchive", systemImage: "tray.and.arrow.up") { Task { _ = await client.unarchive(id) } }
                        }
                    }
                    .onAppear { if id == ids.last { client.loadMoreArchived() } }
            }
        }
        footer(empty: ids.isEmpty).listRowSeparator(.hidden)
    }
    @ViewBuilder private func footer(empty: Bool) -> some View {
        if archive.loading || (!archive.list.loaded && client.connection == "ready") {
            HStack { Spacer(); ProgressView().accessibilityLabel("Loading archived threads"); Spacer() }
        } else if archive.list.failed {
            Button("Retry loading older threads") { client.loadMoreArchived() }
                .frame(minHeight: AceTheme.Dimensions.touchTarget).accessibilityIdentifier("archive.retry")
        } else if !archive.list.loaded {
            ContentUnavailableView("Can't reach this machine", systemImage: "wifi.slash",
                                   description: Text("Archived threads load once it's connected."))
        } else if empty {
            ContentUnavailableView("Nothing archived", systemImage: "archivebox", description: Text("Threads you archive on this machine wait here."))
        } else if archive.canLoadMore {
            Button("Show older archived threads") { client.loadMoreArchived() }
                .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                .frame(minHeight: AceTheme.Dimensions.touchTarget).accessibilityIdentifier("archive.more")
        }
    }
}

/// Where the composer would be for an archived thread: it's read-only until it's unarchived.
struct ArchivedNote: View {
    let canOperate: Bool
    let unarchive: () async -> Bool
    @State private var working = false
    var body: some View {
        HStack(spacing: AceTheme.Spacing.md) {
            Label("Archived", systemImage: "archivebox")
                .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
            Spacer(minLength: AceTheme.Spacing.sm)
            if canOperate {
                Button("Unarchive") { working = true; Task { _ = await unarchive(); working = false } }
                    .buttonStyle(.bordered).disabled(working)
                    .frame(minHeight: AceTheme.Dimensions.touchTarget)
                    .accessibilityIdentifier("thread.unarchive")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("thread.archived")
    }
}
