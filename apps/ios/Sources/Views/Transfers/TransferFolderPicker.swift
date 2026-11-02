import SwiftUI

/// Where a project the other machine doesn't have yet goes: its default folder, or one of its
/// folders found with Add project's folder search on that machine's own connection.
struct TransferFolderPicker: View {
    let client: ClientModel
    let machine: String
    let chosen: String?
    let choose: (String?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    private var folders: (query: String, state: String, folders: [ComposeFolder])? { client.compose.folders }

    var body: some View {
        List {
            Section {
                row("Default", subtitle: "The folder \(machine) uses for new projects", path: nil)
            }
            .insetRowBackground()
            switch folders?.state {
            case "ready":
                Section {
                    ForEach(folders?.folders ?? []) { folder in row(folder.name, subtitle: folder.path, path: folder.path) }
                    if folders?.folders.isEmpty == true { EmptyState(systemImage: "folder", title: "No folders match").listRowBackground(Color.clear) }
                } header: { InsetHeader("Folders on \(machine)") }
                .insetRowBackground()
            case "forbidden":
                EmptyState(systemImage: "desktopcomputer", title: "Can't browse folders", line: "\(machine) doesn't let this phone browse its folders.")
                    .listRowBackground(Color.clear)
            case "failed":
                EmptyState(icon: nil, title: "Couldn't search folders", line: "Couldn't search the folders on \(machine). Check the connection and try again.", failed: true)
                    .listRowBackground(Color.clear)
            default:
                SkeletonRows(count: 3, label: "Reading folders").listRowBackground(Color.clear).listRowInsets(EdgeInsets())
            }
        }
        .insetGroupedList()
        .searchBarEdge()
        .searchable(text: $query, prompt: "Search folders on \(machine)")
        .navigationTitle("Folder").navigationBarTitleDisplayMode(.inline)
        .task(id: query) {
            if !query.isEmpty { try? await Task.sleep(for: .milliseconds(250)) }
            guard !Task.isCancelled else { return }
            client.composeAction(["kind": "folders", "query": query])
        }
    }
    private func row(_ title: String, subtitle: String, path: String?) -> some View {
        Button { choose(path); dismiss() } label: {
            HStack(spacing: AceTheme.Spacing.md) {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                    Text(title).aceFont(InsetStyle.label, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
                    Text(subtitle).aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
                        .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1).truncationMode(.middle)
                }
                Spacer(minLength: AceTheme.Spacing.none)
                if chosen == path { Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(AceTheme.Colours.foreground) }
            }
            .padding(.vertical, AceTheme.Spacing.xs).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(chosen == path ? .isSelected : [])
        .accessibilityIdentifier("transfer.folder.\(path ?? "default")")
    }
}
