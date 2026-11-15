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
/// A Skills and commands page's read (`bridge/catalog-page.ts`): a stale first answer is
/// `refreshing`, and asking again with `settle` answers once discovery ends or the retries run out.
struct CatalogPageReply: Decodable {
    let entries: [CatalogReply.Entry]
    let stale: Bool
    let refreshing: Bool
    let notice: String?
}
extension ClientModel {
    /// Reads a catalog page, showing the first answer at once and the settled one after it.
    func catalogPage(_ target: [String: Any], show: (CatalogPageReply) -> Void) async throws {
        let request = target.merging(["type": "catalog.page"]) { _, page in page }
        let first = try await service(request, as: CatalogPageReply.self)
        show(first)
        guard first.refreshing, !Task.isCancelled else { return }
        show(try await service(request.merging(["settle": true]) { _, settle in settle }, as: CatalogPageReply.self))
    }
}
struct ThreadCatalogView: View {
    let model: ClientModel
    let threadId: String
    @State private var entries: [CatalogReply.Entry] = []
    @State private var query = ""
    @State private var problem: String?
    @State private var notice: String?
    @State private var loaded = false
    @State private var loading = false
    private var filtered: [CatalogReply.Entry] { entries.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) || $0.description.localizedCaseInsensitiveContains(query) } }
    var body: some View {
        ScrollView {
            QuietSection {
            ServiceProblem(message: problem)
            if problem != nil { Button("Retry") { Task { await read() } }.buttonStyle(.textAction()).disabled(loading) }
            if !loaded && problem == nil { SkeletonRows(label: "Reading skills and commands") }
            if let notice { QuietSectionRow { QuietRowText(title: notice, tone: AceDesign.Ink.muted) } }
            ForEach(filtered) { entry in
                NavigationLink { CatalogInvokeView(model: model, threadId: threadId, entry: entry) } label: {
                    QuietSectionRow {
                        QuietRowText(title: entry.title ?? entry.name, detail: entry.description)
                        Text(entry.kind.capitalized).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote).foregroundStyle(AceDesign.Ink.muted)
                        RowCaret()
                    }
                }
            }
            if loaded && !entries.isEmpty && filtered.isEmpty {
                QuietSectionRow { QuietRowText(title: "No matching skills or commands.", tone: AceDesign.Ink.muted) }
            }
            if loaded && entries.isEmpty && problem == nil && notice == nil {
                QuietSectionRow { QuietRowText(title: "No skills or commands available for this thread.", tone: AceDesign.Ink.muted) }
            }
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
            try await model.catalogPage(["threadId": threadId]) { reply in
                entries = reply.entries; notice = reply.notice; problem = nil; loaded = true
            }
        } catch { notice = nil; problem = error.localizedDescription }
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
