import SwiftUI

private struct CatalogReply: Decodable {
    struct Entry: Decodable, Identifiable {
        let id: String
        let kind: String
        let name: String
        let title: String?
        let description: String
    }
    let entries: [Entry]
    let stale: Bool
}
struct ThreadCatalogView: View {
    let model: ClientModel
    let threadId: String
    @State private var entries: [CatalogReply.Entry] = []
    @State private var query = ""
    @State private var problem: String?
    @State private var stale = false
    var body: some View {
        List {
            ServiceProblem(message: problem)
            if stale { Text("Showing cached entries. Refresh when your machine is available.") }
            ForEach(entries.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) || $0.description.localizedCaseInsensitiveContains(query) }) { entry in
                NavigationLink { CatalogInvokeView(model: model, threadId: threadId, entry: entry) } label: {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                        LabeledContent(entry.title ?? entry.name, value: entry.kind.capitalized)
                        Text(entry.description).lineLimit(3).foregroundStyle(AceTheme.Colours.mutedForeground)
                    }
                }
            }
            if entries.isEmpty && problem == nil { Text("No skills or commands available for this thread.") }
        }
        .searchable(text: $query, prompt: "Find a skill or command")
        .navigationTitle("Skills and commands").navigationBarTitleDisplayMode(.inline)
        .task { await read() }.refreshable { await read() }
    }
    private func read() async {
        do {
            let reply = try await model.service(["type": "catalog.list", "threadId": threadId, "limit": 512], as: CatalogReply.self)
            entries = reply.entries; stale = reply.stale; problem = nil
        } catch { problem = error.localizedDescription }
    }
}
private struct CatalogInvokeView: View {
    let model: ClientModel
    let threadId: String
    let entry: CatalogReply.Entry
    @State private var words = ""
    @State private var saved = false
    @State private var saving = false
    var body: some View {
        Form {
            Text(entry.description)
            TextField("Instructions or arguments", text: $words, axis: .vertical).lineLimit(3...8)
            Button(saved ? "Saved for delivery" : "Use \(entry.name)") {
                saving = true
                Task {
                    let id = model.admissions.nextId()
                    saved = await model.admissions.wait(id: id) {
                        model.command(["type": "thread.send", "threadId": threadId, "input": [["type": "mention", "entryId": entry.id, "name": entry.name, "kind": entry.kind, "arguments": words]]], requestId: id)
                    }
                    saving = false
                }
            }.disabled(!model.canOperate || saving || saved)
            if let error = model.error { ServiceProblem(message: error) }
        }
        .navigationTitle(entry.title ?? entry.name).navigationBarTitleDisplayMode(.inline)
    }
}
