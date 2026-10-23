import SwiftUI

private struct PastSession: Decodable, Identifiable {
    struct Support: Decodable { let status: String; let reason: String? }
    let id: String
    let title: String
    let provider: String
    let messageCount: Int
    let support: Support
}
private struct PastSessionsReply: Decodable {
    struct Cursor: Codable { let lastActivity: Double; let id: String }
    struct Scan: Decodable { let state: String; let error: String? }
    let sessions: [PastSession]
    let next: Cursor?
    let scan: Scan?
}
private struct HistoryImportReply: Decodable { let status: String; let threadId: String?; let reason: String? }

struct PastSessionsView: View {
    let model: ClientModel
    let project: NativeProject
    @State private var sessions: [PastSession] = []
    @State private var next: PastSessionsReply.Cursor?
    @State private var state = ""
    @State private var query = ""
    @State private var problem: String?
    @State private var importing: String?
    @State private var path: [String] = []
    @State private var loading = false
    var body: some View {
        List {
            Group {
                ForEach(sessions) { session in
                    Button {
                        importing = session.id
                        Task { await open(session) }
                    } label: {
                        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                            Text(session.title.isEmpty ? "Untitled session" : session.title).foregroundStyle(AceTheme.Colours.foreground).lineLimit(2)
                            Text("\(session.provider.capitalized) · \(session.messageCount) messages").foregroundStyle(AceTheme.Colours.mutedForeground)
                            if let reason = session.support.reason { Text(reason).foregroundStyle(AceTheme.Colours.subtleForeground) }
                        }
                    }.disabled(importing != nil || session.support.status != "supported" || !model.canOperate)
                }
                if loading || importing != nil { ProgressView().accessibilityLabel(importing == nil ? "Loading sessions" : "Opening session") }
                ServiceProblem(message: problem)
                if problem != nil { Button("Retry") { Task { await read() } } }
                if ["scanning", "retrying"].contains(state) { Label("Reading CLI history", systemImage: "clock") }
                if !loading && sessions.isEmpty && problem == nil { ContentUnavailableView.search(text: query) }
                if next != nil { Button("Show more sessions") { Task { await read(more: true) } }.disabled(loading) }
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .searchable(text: $query, prompt: "Search past sessions")
        .navigationTitle("Past CLI sessions").navigationBarTitleDisplayMode(.inline)
        .task(id: query) {
            await read()
            while ["scanning", "retrying"].contains(state), !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
                await read()
            }
        }
        .refreshable { await read(rescan: true) }
        .navigationDestination(isPresented: Binding(get: { !path.isEmpty }, set: { if !$0 { path = []; model.back() } })) {
            if let thread = model.thread { ThreadView(model: model, thread: thread) { model.open($0) } }
        }
        .onDisappear { Task { _ = try? await model.service(["type": "history.release"], as: ServiceValue.self) } }
    }
    private func read(more: Bool = false, rescan: Bool = false) async {
        loading = true; problem = nil
        defer { loading = false }
        do {
            var request: [String: Any] = ["type": "history.list", "cwd": project.path, "search": query, "limit": 50, "rescan": rescan]
            if more, let next { request["before"] = ["lastActivity": next.lastActivity, "id": next.id] }
            let reply = try await model.service(request, as: PastSessionsReply.self)
            guard !Task.isCancelled else { return }
            sessions = (more ? sessions : []) + reply.sessions; next = reply.next; state = reply.scan?.state ?? "ready"
            problem = reply.scan?.error
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
    private func open(_ session: PastSession) async {
        defer { importing = nil }
        do {
            let reply = try await model.service(["type": "history.import", "sourceId": session.id, "workspaceId": project.id], as: HistoryImportReply.self)
            guard reply.status == "imported", let id = reply.threadId else { throw ServiceFailure(message: reply.reason ?? "This session couldn't be imported.") }
            model.open(id); path = [id]
        } catch { problem = error.localizedDescription }
    }
}
