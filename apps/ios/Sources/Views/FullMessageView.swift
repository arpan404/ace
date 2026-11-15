import SwiftUI

/// A message or thought longer than its row, read whole (`native.message`).
struct FullMessageView: View {
    let model: ClientModel
    let threadId: String
    let item: TranscriptRow
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var text: String?
    @State private var problem: String?
    private struct Reply: Decodable { let text: String }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: AceDesign.Space.row) {
                    // The row's own text shows at once; the whole text replaces it when it arrives.
                    AceMarkdown(text: text ?? item.text, streaming: text == nil && !item.complete,
                                tone: item.type == "reasoning" ? .muted : .body, flavor: AnswerMarkdown.flavor,
                                renderDiagram: AnswerMarkdown.renderDiagram(dark: scheme == .dark)).onAppear { DisclosureTrace.shared.shown(item.id) }
                    if text == nil && problem == nil {
                        Text("Reading the rest…").aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                            .foregroundStyle(AceTheme.Colours.subtleForeground)
                            .accessibilityAddTraits(.updatesFrequently)
                    }
                    ServiceProblem(message: problem)
                    if problem != nil { Button("Retry") { Task { await read() } } }
                }.padding(.horizontal, AceDesign.Space.margin).padding(.vertical, AceDesign.Space.margin).frame(maxWidth: .infinity, alignment: .leading)
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
