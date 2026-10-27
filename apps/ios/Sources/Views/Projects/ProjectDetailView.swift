import SwiftUI

private struct ProjectReply: Decodable {
    struct Result: Decodable { let kind: String; let project: NativeProject?; let code: String? }
    let result: Result
}

/// One project: its folder, files and past sessions, the notes every agent reads, where else it
/// opens, then Edit and Remove. Read again whenever the machine's projects change.
struct ProjectDetailView: View {
    let model: ClientModel
    @State private var project: NativeProject
    @State private var editing = false
    @State private var removing = false
    @State private var gone = false
    @Environment(\.dismiss) private var dismiss

    init(model: ClientModel, project: NativeProject) {
        self.model = model
        _project = State(initialValue: project)
    }

    var body: some View {
        List {
            Section {
                Text(project.path).aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.mutedForeground).textSelection(.enabled)
                    .accessibilityIdentifier("project.path")
            }
            .insetRowBackground()
            Section {
                NavigationLink { FilesScreen(model: model, scope: .project(project.id), subtitle: project.name, mention: nil) } label: { InsetRow("Files", systemImage: "folder") }
                NavigationLink { PastSessionsView(model: model, project: project) } label: { InsetRow("Past CLI sessions", systemImage: "clock.arrow.circlepath") }
            }
            .insetRowBackground()
            notes
            // Shown only while this machine links to another (ADR 0101).
            if model.canOperate, model.transfers.linked {
                Section {
                    Button { model.openOn(workspaceId: project.id, name: project.name) } label: { InsetRow("Open on…", systemImage: "desktopcomputer") }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("project.openOn")
                }
                .insetRowBackground()
            }
            if model.canOperate {
                Section {
                    Button("Remove project…", role: .destructive) { removing = true }
                        .accessibilityIdentifier("project.remove")
                } footer: { Text("Its threads are deleted. The folder stays on the computer.") }
                .insetRowBackground()
            }
        }
        .insetGroupedList()
        .navigationTitle(project.name).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if model.canOperate {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Edit") { editing = true }.accessibilityIdentifier("project.edit")
                }
            }
        }
        .transferSheet(model: model, kind: "project")
        .projectRemoval(model: model, project: project, isPresented: $removing) { dismiss() }
        .sheet(isPresented: $editing) {
            NavigationStack {
                EditProjectView(model: model, project: project) { saved in
                    editing = false
                    if saved == .removed { dismiss() } else { Task { await reread() } }
                }
            }
            .tint(AceTheme.Colours.foreground)
            .presentationDetents([.large]).presentationDragIndicator(.visible)
        }
        .task(id: model.readGeneration(ProjectsView.firstPage)) { await reread() }
        .overlay {
            if gone { ContentUnavailableView("Project removed", systemImage: "folder", description: Text("It's no longer on this machine.")) }
        }
    }

    @ViewBuilder private var notes: some View {
        Section {
            if project.notes.isEmpty {
                Text("No notes yet. Agents add what they learn about the project here, and so can you.")
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
            }
            ForEach(project.notes) { note in
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                    Text(note.text).aceFont(InsetStyle.value, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
                        .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    if note.threadId != nil {
                        Text("From an agent").aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground)
                    }
                }
                .padding(.vertical, AceTheme.Spacing.xs)
            }
            if model.canOperate {
                Button(project.notes.isEmpty ? "Add a note" : "Edit notes") { editing = true }
                    .accessibilityIdentifier("project.notes.edit")
            }
        } header: { InsetHeader("Notes") } footer: { Text("Every thread and agent in this project reads these. They stay in ace, never in the repository.") }
        .insetRowBackground()
    }

    private func reread() async {
        guard model.connection == "ready" else { return }
        guard let reply = try? await model.service(["type": "projects.request", "operation": ["op": "workspace.get", "workspaceId": project.id]], as: ProjectReply.self) else { return }
        if let fresh = reply.result.project { project = fresh; gone = false }
        else if reply.result.code?.contains("not_found") == true { gone = true }
    }
}

/// Remove a project from ace, keeping its folder, as the web's Remove dialog does: confirm, and
/// when its threads still run, offer to stop them and remove it anyway.
private struct ProjectRemoval: ViewModifier {
    let model: ClientModel
    let project: NativeProject
    @Binding var isPresented: Bool
    let removed: () -> Void
    @State private var running = false
    @State private var problem: String?
    @State private var busy = false

    func body(content: Content) -> some View {
        content
            .confirmationDialog("Remove \(project.name)?", isPresented: $isPresented, titleVisibility: .visible) {
                Button("Remove project", role: .destructive) { remove(stopRunning: false) }
                    .accessibilityIdentifier("project.remove.confirm")
            } message: { Text("Its threads are deleted. No files are. \(project.path) stays on the computer and you can add it again later.") }
            .confirmationDialog("Threads in \(project.name) are still running", isPresented: $running, titleVisibility: .visible) {
                Button("Stop threads and remove", role: .destructive) { remove(stopRunning: true) }
                    .accessibilityIdentifier("project.remove.stop")
            } message: { Text("Stop them to remove the project now. The folder stays on the computer.") }
            .alert("Couldn't remove \(project.name)", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
                Button("OK") { problem = nil }
            } message: { Text(problem ?? "") }
            .disabled(busy)
    }

    private func remove(stopRunning: Bool) {
        busy = true
        Task {
            defer { busy = false }
            let outcome = await model.removeProject(project.id, stopRunning: stopRunning)
            if outcome.ok { removed() }
            else if outcome.code == "workspace_threads_running" { running = true }
            else { problem = outcome.message ?? "Try again." }
        }
    }
}

extension View {
    func projectRemoval(model: ClientModel, project: NativeProject, isPresented: Binding<Bool>, removed: @escaping () -> Void) -> some View {
        modifier(ProjectRemoval(model: model, project: project, isPresented: isPresented, removed: removed))
    }
}
