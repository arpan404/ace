import SwiftUI

/// Files deleted from the thread's checkout, newest first, each restorable until its recovery
/// period ends. Restoring never replaces a file that took its place.
struct RecentlyDeletedView: View {
    let model: ClientModel
    let scope: FilesScope
    @State private var entries: [TrashEntry] = []
    @State private var next: String?
    @State private var loaded = false
    @State private var loading = false
    @State private var busy: String?
    @State private var problem: String?

    var body: some View {
        List {
            if !loaded && problem == nil {
                SkeletonRows(label: "Loading recently deleted files").listRowSeparator(.hidden).listRowInsets(EdgeInsets())
            } else if loaded && entries.isEmpty {
                EmptyState(systemImage: "trash", title: "No recently deleted files").listRowSeparator(.hidden)
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
                        .buttonStyle(.textAction()).disabled(busy != nil || !model.canOperate)
                        .accessibilityIdentifier("trash.restore.\(entry.path)")
                }
                .frame(minHeight: AceDesign.Size.rowDetail)
                .listRowInsets(EdgeInsets(top: AceTheme.Spacing.none, leading: AceDesign.Space.margin, bottom: AceTheme.Spacing.none, trailing: AceDesign.Space.margin))
                .listRowBackground(AceTheme.Colours.background)
            }
            if let next {
                Button("Show older") { Task { await load(after: next) } }.disabled(loading)
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
        .refreshable { await load(after: nil) }
    }

    private func load(after cursor: String?) async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        var operation: [String: Any] = ["op": "trash"]
        if let cursor { operation["after"] = cursor }
        do {
            let page = try await model.files(scope, operation, as: TrashPage.self)
            if cursor == nil { entries = page.entries }
            else { entries += page.entries.filter { entry in !entries.contains { $0.id == entry.id } } }
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
