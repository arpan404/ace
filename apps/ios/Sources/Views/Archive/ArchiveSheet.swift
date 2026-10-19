import SwiftUI

/// Archived threads, one machine at a time (the web's Archived screen): most recently archived
/// first, 20 per page from the SDK's archive window. A thread opens read-only; Unarchive returns
/// it to the inbox. The sheet follows the archive only while it shows that machine.
struct ArchiveSheet: View {
    let inbox: MachineInbox
    @State private var machineId: String
    @State private var path: [String] = []
    @State private var following: String?
    @Environment(\.dismiss) private var dismiss

    init(inbox: MachineInbox, machineId: String) {
        self.inbox = inbox
        _machineId = State(initialValue: machineId)
    }
    private var client: ClientModel? { inbox.client(machineId) }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if inbox.sessions.count > 1 {
                    Picker("Machine", selection: $machineId) {
                        ForEach(inbox.sessions) { session in Text(inbox.name(session.hostId)).tag(session.hostId) }
                    }
                    .accessibilityIdentifier("archive.machine")
                }
                if let client { ArchiveRows(client: client, open: open) }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(AceTheme.Colours.background)
            .navigationTitle("Archived").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .navigationDestination(for: String.self) { id in
                if let client, let thread = client.thread, thread.id == id {
                    ThreadView(model: client, thread: thread) { child in client.open(child); path.append(child) }
                }
            }
            .onChange(of: path) { old, new in
                if !old.isEmpty && new.isEmpty { client?.back() }
                else if new.count < old.count, let parent = new.last { client?.open(parent) }
            }
        }
        .tint(AceTheme.Colours.foreground)
        .task(id: machineId) { follow(machineId) }
        .onDisappear { follow(nil) }
    }
    /// Only one machine's archive window is open at a time; the others stay on their home window.
    private func follow(_ hostId: String?) {
        guard following != hostId else { return }
        if let following { inbox.client(following)?.closeArchive() }
        following = hostId
        if let hostId { inbox.client(hostId)?.openArchive() }
    }
    private func open(_ id: String) {
        guard let client else { return }
        client.open(id); path = [id]
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
