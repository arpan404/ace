import SwiftUI

private struct ProjectReply: Decodable {
    struct Result: Decodable { let kind: String; let project: NativeProject?; let code: String? }
    let result: Result
}

/// One project: its folder, files, past sessions and Git repositories, the notes every agent reads, where else it
/// opens, then Edit and Remove. Read again whenever the machine's projects change.
struct ProjectDetailView: View {
    let model: ClientModel
    @State private var project: NativeProject
    @State private var editing = false
    @State private var removing = false
    @State private var gone = false
    @State private var saves = 0
    @State private var publishing = false
    @State private var refreshProblem: String?
    @Environment(\.dismiss) private var dismiss

    init(model: ClientModel, project: NativeProject) {
        self.model = model
        _project = State(initialValue: project)
    }

    var body: some View {
        List {
            if let refreshProblem {
                Section { ProblemRow("Couldn't refresh this project.", detail: refreshProblem, id: "project.problem") { Task { await reread() } } }
            }
            Section {
                Text(verbatim: project.path).aceMonospace(AceDesign.TextRole.code)
                    .foregroundStyle(AceDesign.Ink.muted).textSelection(.enabled)
                    .accessibilityIdentifier("project.path")
            } header: { InsetHeader("Folder") }
            .insetRowBackground()

            Section {
                NavigationLink { FilesScreen(model: model, scope: .project(project.id), subtitle: project.name, mention: nil) } label: { InsetRow("Files", icon: nil) }
                NavigationLink { PastSessionsView(model: model, project: project) } label: { InsetRow("Past CLI sessions", icon: nil) }
                NavigationLink { ProjectRepositoriesView(model: model, project: project) } label: {
                    InsetRow("Repositories", icon: nil, subtitle: "Where reviews are read and pull requests open")
                }
                .accessibilityIdentifier("project.repositories")
                OpenOnHostMenu(model: model, target: HostOpenTarget(workspaceId: project.id)) {
                    InsetRow(icon: nil, title: "Open in…", subtitle: "An editor or the file manager on the computer") { RowCaret() }
                }
                .accessibilityIdentifier("project.openIn")
                if model.canOperate {
                    Button { publishing = true } label: {
                        InsetRow(icon: nil, title: "Publish repository…", subtitle: "A new GitHub repository for this project") { RowCaret() }
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("project.publish")
                }
                // Shown only while this machine links to another (ADR 0101).
                if model.canOperate, model.transfers.linked {
                    Button { model.openOn(workspaceId: project.id, name: project.name) } label: {
                        InsetRow(icon: nil, title: "Open on…") { RowCaret() }
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("project.openOn")
                }
            }
            .insetRowBackground()

            notes
            if model.canOperate {
                Section {
                    Button("Remove project…", role: .destructive) { removing = true }
                        .buttonStyle(.rowAction)
                        .accessibilityIdentifier("project.remove")
                } footer: { Text("Its threads are deleted. The folder stays on the computer.") }
                .insetRowBackground()
            }
        }
        .insetGroupedList()
        .smoothChange(project.notes.map(\.id) + project.notes.map(\.text))
        .smoothChange(gone)
        .sensoryFeedback(.success, trigger: saves)
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
                    if saved == .removed { dismiss() }
                    else if saved == .saved { saves += 1; Task { await reread() } }
                }
            }
            .tint(AceDesign.Ink.action)
            .presentationDetents([.large]).presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $publishing) {
            NavigationStack { PublishRepositoryView(model: model, project: project) { publishing = false } }
                .tint(AceDesign.Ink.action)
                .presentationDetents([.large]).presentationDragIndicator(.visible)
        }
        .task(id: [model.connection, String(model.readGeneration(ProjectsView.firstPage))]) { await reread() }
        .overlay {
            if gone {
                EmptyState(icon: .folder, title: "Project removed", line: "It's no longer on this machine.")
                    .transition(.opacity)
            }
        }
    }

    @ViewBuilder private var notes: some View {
        Section {
            ForEach(project.notes) { note in
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                    Text(note.text).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.primary)
                        .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    if note.threadId != nil {
                        Text("From an agent").aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                    }
                }
                .padding(.vertical, AceDesign.Space.tight)
            }
            if model.canOperate {
                Button(project.notes.isEmpty ? "Add a note" : "Edit notes") { editing = true }
                    .buttonStyle(.rowAction)
                    .accessibilityIdentifier("project.notes.edit")
            } else if project.notes.isEmpty {
                Text("No notes yet").aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.muted)
            }
        } header: { InsetHeader("Notes") } footer: { Text("Every agent in this project reads these. They stay in ace, not in the repository.") }
        .insetRowBackground()
    }

    private func reread() async {
        guard model.connection == "ready" else { refreshProblem = "Your computer isn't connected."; return }
        let reply: ProjectReply
        do { reply = try await model.service(["type": "projects.request", "operation": ["op": "workspace.get", "workspaceId": project.id]], as: ProjectReply.self) }
        catch { if !Task.isCancelled { refreshProblem = error.localizedDescription }; return }
        refreshProblem = nil
        if let fresh = reply.result.project { project = fresh; gone = false }
        else if reply.result.code?.contains("not_found") == true { gone = true }
        else { refreshProblem = "Your computer answered \(reply.result.code ?? "unavailable")." }
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
    @State private var done = 0
    @State private var waiting = false

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .bottom) {
                if waiting {
                    Text("Waiting for your computer to remove \(project.name)…")
                        .font(AceDesign.Typeface.meta)
                        .padding(.horizontal, AceDesign.Space.margin).padding(.vertical, AceDesign.Space.related)
                        .floatingGlass()
                        .padding(.bottom, AceDesign.Space.margin)
                        .transition(.opacity)
                }
            }
            .smoothChange(waiting)
            .sensoryFeedback(.success, trigger: done)
            .confirmationDialog("Remove \(project.name)?", isPresented: $isPresented, titleVisibility: .visible) {
                Button("Remove project", role: .destructive) { remove(stopRunning: false) }
                    .accessibilityIdentifier("project.remove.confirm")
            } message: { Text("Its threads are deleted. No files are. \(project.path) stays on the computer and you can add it again later.") }
            .confirmationDialog("Threads in \(project.name) are still running", isPresented: $running, titleVisibility: .visible) {
                Button("Stop threads and remove", role: .destructive) { remove(stopRunning: true) }
                    .accessibilityIdentifier("project.remove.stop")
            } message: { Text("Stop them to remove the project now. The folder stays on the computer.") }
            .alert("Couldn't remove \(project.name)", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
                Button("Dismiss", role: .cancel) { problem = nil }
            } message: { Text(problem ?? "") }
            .disabled(busy)
    }

    private func remove(stopRunning: Bool) {
        busy = true
        Task {
            defer { busy = false }
            let outcome = await model.removeProject(project.id, stopRunning: stopRunning) { waiting = true }
            waiting = false
            if outcome.ok {
                done += 1
                // The haptic lands before the screen goes.
                try? await Task.sleep(for: .milliseconds(120))
                removed()
            }
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
