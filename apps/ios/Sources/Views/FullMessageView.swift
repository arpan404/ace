import SwiftUI

struct FullMessageView: View {
    let model: ClientModel
    let threadId: String
    let item: TranscriptRow
    @Environment(\.dismiss) private var dismiss
    @State private var text: String?
    @State private var problem: String?
    private struct Reply: Decodable { let text: String }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.md) {
                    if let text { MarkdownView(text: text) }
                    else if problem == nil { ProgressView("Reading full message…") }
                    ServiceProblem(message: problem)
                    if problem != nil { Button("Retry") { Task { await read() } } }
                }.padding(.horizontal, AceTheme.Spacing.xl).padding(.vertical, AceTheme.Spacing.lg).frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle(item.type == "reasoning" ? "Thought" : "Message").navigationBarTitleDisplayMode(.inline)
            .escapeCloses { dismiss() }
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }.readWhenConnected(model) { await read() }
    }
    private func read() async {
        problem = nil
        do { text = try await model.service(["type": "native.message", "threadId": threadId, "itemId": item.id], as: Reply.self).text }
        catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
}
