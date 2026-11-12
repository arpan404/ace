import SwiftUI

struct CatalogReply: Decodable {
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
    @State private var loaded = false
    @State private var loading = false
    private var filtered: [CatalogReply.Entry] { entries.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) || $0.description.localizedCaseInsensitiveContains(query) } }
    var body: some View {
        ScrollView {
            QuietSection {
            ServiceProblem(message: problem)
            if problem != nil { Button("Retry") { Task { await read() } }.buttonStyle(.textAction()).disabled(loading) }
            if !loaded && problem == nil { SkeletonRows(label: "Reading skills and commands") }
            if stale { Text("Showing cached entries. Refresh when your machine is available.") }
            ForEach(filtered) { entry in
                NavigationLink { CatalogInvokeView(model: model, threadId: threadId, entry: entry) } label: {
                    QuietSectionRow {
                        QuietRowText(title: entry.title ?? entry.name, detail: entry.description)
                        Text(entry.kind.capitalized).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote).foregroundStyle(AceDesign.Ink.muted)
                        RowCaret()
                    }
                }
            }
            if loaded && !entries.isEmpty && filtered.isEmpty { Text("No matching skills or commands.").foregroundStyle(AceDesign.Ink.muted) }
            if loaded && entries.isEmpty && problem == nil { Text("No skills or commands available for this thread.") }
            }.padding(.vertical, AceDesign.Space.related)
        }
        .buttonStyle(.plain)
        .background(AceDesign.Surface.background)
        .searchable(text: $query, prompt: "Find a skill or command")
        .navigationTitle("Skills and commands").navigationBarTitleDisplayMode(.inline)
        .readWhenConnected(model) { await read() }.refreshable { await read() }
    }
    private func read() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let reply = try await model.service(["type": "catalog.list", "threadId": threadId, "limit": 512], as: CatalogReply.self)
            entries = reply.entries; stale = reply.stale; problem = nil; loaded = true
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
        ScrollView {
            QuietSection {
            QuietSectionRow { Text(entry.description) }
            QuietSectionRow {
            TextField("Instructions or arguments", text: $words, axis: .vertical).lineLimit(3...8)
            }
            QuietSectionRow {
            Button(saved ? "Saved for delivery" : "Use \(entry.name)") {
                saving = true
                Task {
                    let id = model.admissions.nextId()
                    saved = await model.admissions.wait(id: id) {
                        model.command(["type": "thread.send", "threadId": threadId, "input": [["type": "mention", "entryId": entry.id, "name": entry.name, "kind": entry.kind, "arguments": words]]], requestId: id)
                    }
                    saving = false
                }
            }.buttonStyle(.textAction(.prominent)).disabled(!model.canOperate || saving || saved)
            }
            if let error = model.error { ServiceProblem(message: error) }
            }.padding(.vertical, AceDesign.Space.related)
        }
        .background(AceDesign.Surface.background)
        .navigationTitle(entry.title ?? entry.name).navigationBarTitleDisplayMode(.inline)
    }
}
