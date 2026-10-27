import SwiftUI

/// Which project threads move to: the machine's projects (recent first) without the one they are
/// all in already, found by typing. Picking moves them at once, with Undo in the toast.
struct MoveThreadSheet: View {
    let client: ClientModel
    /// The project every moving thread is in, left out of the list; nil when they differ.
    let from: String?
    /// "“Fix login”" or "3 threads", for the title.
    let subject: String
    let choose: (ComposeProject) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var projects: [ComposeProject] {
        let needle = query.trimmingCharacters(in: .whitespaces)
        return client.compose.projects.filter { project in
            project.id != from && (needle.isEmpty || project.name.localizedCaseInsensitiveContains(needle)
                                   || project.path.localizedCaseInsensitiveContains(needle))
        }
    }

    var body: some View {
        NavigationStack {
            List {
                switch client.compose.projectsState {
                case "failed":
                    ContentUnavailableView {
                        Label("Couldn't read projects", systemImage: "wifi.exclamationmark")
                    } description: { Text("Your computer didn't answer.") } actions: { Button("Try again", action: reload) }
                    .listRowBackground(Color.clear)
                case "ready":
                    if projects.isEmpty {
                        ContentUnavailableView(query.isEmpty ? "No other project" : "No projects match", systemImage: "folder",
                                               description: query.isEmpty ? Text("Add one on your computer first.") : nil)
                            .listRowBackground(Color.clear)
                    } else {
                        Section {
                            ForEach(projects) { project in
                                Button { choose(project); dismiss() } label: {
                                    VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                                        Text(project.name).aceFont(InsetStyle.label, relativeTo: .body)
                                            .foregroundStyle(AceTheme.Colours.foreground)
                                        Text(project.path).aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
                                            .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1).truncationMode(.middle)
                                    }
                                    .padding(.horizontal, AceTheme.Spacing.md)
                                    .padding(.vertical, AceTheme.Spacing.sm)
                                    .frame(maxWidth: .infinity, minHeight: AceTheme.Dimensions.touchTarget, alignment: .leading)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.row)
                                .accessibilityIdentifier("move.project.\(project.id)")
                                .inboxRowChrome()
                            }
                        } header: {
                            Text("Projects").aceFont(AceTheme.Typography.label, relativeTo: .subheadline).textCase(nil)
                                .foregroundStyle(AceTheme.Colours.subtleForeground)
                        }
                    }
                default:
                    HStack { Spacer(); ProgressView().accessibilityLabel("Loading projects"); Spacer() }.listRowBackground(Color.clear)
                }
            }
            // Heading and rows, as the inbox draws them: no card around the list.
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(AceTheme.Colours.background)
            .environment(\.defaultMinListRowHeight, 0)
            .searchable(text: $query, prompt: "Search projects")
            .navigationTitle("Move \(subject) to…").navigationBarTitleDisplayMode(.inline)
            .escapeCloses { dismiss() }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Close").accessibilityIdentifier("move.close")
                }
            }
            .task { reload() }
            .refreshable { reload() }
        }
        .tint(AceTheme.Colours.foreground)
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
    }

    private func reload() { client.composeAction(["kind": "projects"]) }
}

extension View {
    /// The inbox's organize questions: Delete (red words, Cancel first), the project a move goes
    /// to, and what the machines refused.
    func organizeSheets(_ organize: InboxOrganize, inbox: MachineInbox) -> some View {
        modifier(OrganizeSheets(organize: organize, inbox: inbox))
    }
}

private struct OrganizeSheets: ViewModifier {
    @Bindable var organize: InboxOrganize
    let inbox: MachineInbox

    func body(content: Content) -> some View {
        content
            .alert(organize.deleting?.question.title ?? "", isPresented: Binding(
                get: { organize.deleting != nil }, set: { if !$0 { organize.deleting = nil } }),
                   presenting: organize.deleting) { ask in
                Button("Cancel", role: .cancel) { organize.deleting = nil }
                Button(ask.question.confirm, role: .destructive) { Task { await organize.confirmDelete(ask, in: inbox) } }
                    .accessibilityIdentifier("delete.confirm")
            } message: { ask in Text(ask.question.message) }
            .alert("Couldn't do that", isPresented: Binding(
                get: { organize.problem != nil }, set: { if !$0 { organize.problem = nil } })) {
                Button("Close", role: .cancel) { organize.problem = nil }
            } message: { Text(organize.problem ?? "") }
            .sheet(item: $organize.moving) { ask in
                if let client = inbox.client(ask.machineId) {
                    let workspaces = Set(ask.keys.compactMap { inbox.row($0)?.workspaceId })
                    let first = ask.keys.first.flatMap { inbox.row($0) }
                    MoveThreadSheet(client: client, from: workspaces.count == 1 ? workspaces.first : nil,
                                    subject: ask.keys.count == 1 ? "“\(first?.title ?? "thread")”" : "\(ask.keys.count) threads") { project in
                        Task { await organize.move(ask.keys, to: project, in: inbox) }
                    }
                }
            }
    }
}
