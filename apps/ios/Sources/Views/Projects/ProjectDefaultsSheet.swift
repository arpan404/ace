import SwiftUI

/// A project named by machine and id, for a sheet that opens its Edit project page.
struct ProjectDefaultsTarget: Identifiable, Hashable {
    let machineId: String
    let projectId: String
    var id: String { "\(machineId)/\(projectId)" }
}

private struct ProjectGetReply: Decodable {
    struct Result: Decodable { let project: NativeProject? }
    let result: Result
}

/// Edit project for a project another page names, read from its machine first: where its
/// defaults, the check command among them, are set. The PR page's "Set check command" opens it.
struct ProjectDefaultsSheet: View {
    let model: ClientModel
    let projectId: String
    let done: () -> Void
    @State private var project: NativeProject?
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            Group {
                if let project {
                    EditProjectView(model: model, project: project) { _ in done() }
                } else if let problem {
                    ContentUnavailableView("Project unavailable", systemImage: "folder", description: Text(problem))
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .toolbar {
                if project == nil { ToolbarItem(placement: .cancellationAction) { Button("Close", action: done) } }
            }
        }
        .tint(AceTheme.Colours.foreground)
        .presentationDetents([.large]).presentationDragIndicator(.visible)
        .task { await load() }
    }

    private func load() async {
        let request: [String: Any] = ["type": "projects.request", "operation": ["op": "workspace.get", "workspaceId": projectId]]
        do {
            let reply = try await model.service(request, as: ProjectGetReply.self)
            if let found = reply.result.project { project = found } else { problem = "It's no longer on this machine." }
        } catch {
            problem = error.localizedDescription
        }
    }
}

/// Gives a page the `setCheckCommand` hook: it opens the named project's defaults in a sheet.
struct ProjectDefaultsHook: ViewModifier {
    let inbox: MachineInbox
    @State private var target: ProjectDefaultsTarget?

    func body(content: Content) -> some View {
        content
            .environment(\.setCheckCommand) { machineId, projectId in
                target = ProjectDefaultsTarget(machineId: machineId, projectId: projectId)
            }
            .sheet(item: $target) { target in
                if let client = inbox.client(target.machineId) {
                    ProjectDefaultsSheet(model: client, projectId: target.projectId) { self.target = nil }
                }
            }
    }
}
