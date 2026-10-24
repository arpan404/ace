import SwiftUI

/// A message or thought longer than its row, read whole (`native.message`).
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
                    // The row's own text shows at once; the whole text replaces it when it arrives.
                    MarkdownView(text: text ?? item.text).onAppear { DisclosureTrace.shared.shown(item.id) }
                    if text == nil && problem == nil {
                        Text("Reading the rest…").aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                            .foregroundStyle(AceTheme.Colours.subtleForeground)
                            .accessibilityAddTraits(.updatesFrequently)
                    }
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
