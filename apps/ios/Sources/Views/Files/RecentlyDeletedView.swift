import SwiftUI

/// Files deleted from the thread's checkout, newest first, each restorable until its recovery
/// period ends. Restoring never replaces a file that took its place.
struct RecentlyDeletedView: View {
    let model: ClientModel
    let scope: FilesScope
    @State private var entries: [TrashEntry] = []
    @State private var next: String?
    @State private var loaded = false
    @State private var busy: String?
    @State private var problem: String?

    var body: some View {
        List {
            if !loaded && problem == nil {
                HStack { Spacer(); ProgressView(); Spacer() }.listRowSeparator(.hidden)
            } else if loaded && entries.isEmpty {
                ContentUnavailableView("No recently deleted files", systemImage: "trash").listRowSeparator(.hidden)
            }
            ForEach(entries) { entry in
                HStack(spacing: AceTheme.Spacing.md) {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                        Text(FileActions.name(entry.path)).aceFont(AceTheme.Typography.body, relativeTo: .body).lineLimit(1)
                        Text("\(entry.path) · \(ByteCountFormatter.string(fromByteCount: Int64(entry.size), countStyle: .file))")
                            .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                            .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1).truncationMode(.head)
                    }
                    Spacer(minLength: AceTheme.Spacing.sm)
                    Button(busy == entry.id ? "Restoring…" : "Restore") { restore(entry) }
                        .buttonStyle(.borderless).disabled(busy != nil || !model.canOperate)
                        .accessibilityIdentifier("trash.restore.\(entry.path)")
                }
                .frame(minHeight: 56)
                .listRowInsets(EdgeInsets(top: 0, leading: AceTheme.Spacing.xl, bottom: 0, trailing: AceTheme.Spacing.xl))
                .listRowBackground(AceTheme.Colours.background)
            }
            if let next {
                Button("Show older") { Task { await load(after: next) } }
                    .listRowBackground(AceTheme.Colours.background)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(AceTheme.Colours.background)
        .navigationTitle("Recently deleted")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) {
            if let problem { FilesStripView(message: problem, dismiss: { self.problem = nil }) }
        }
        .readWhenConnected(model) { await load(after: nil) }
        .refreshable { entries = []; await load(after: nil) }
    }

    private func load(after cursor: String?) async {
        var operation: [String: Any] = ["op": "trash"]
        if let cursor { operation["after"] = cursor }
        do {
            let page = try await model.files(scope, operation, as: TrashPage.self)
            entries = cursor == nil ? page.entries : entries + page.entries
            next = page.nextCursor
            loaded = true
            problem = nil
        } catch is CancellationError {
        } catch {
            problem = error.localizedDescription
        }
    }

    private func restore(_ entry: TrashEntry) {
        busy = entry.id
        Task {
            defer { busy = nil }
            do {
                _ = try await model.files(scope, ["op": "restore", "trashId": entry.id, "path": entry.path], as: FileChange.self)
                entries.removeAll { $0.id == entry.id }
            } catch {
                problem = "Couldn't restore \(FileActions.name(entry.path)). \(error.localizedDescription)"
            }
        }
    }
}
