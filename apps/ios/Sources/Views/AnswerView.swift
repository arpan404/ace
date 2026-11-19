import SwiftUI
import UIKit

extension EnvironmentValues {
    /// Reads an item's whole text from its source (`native.message`), for answers and thoughts
    /// longer than a row carries. Nil where nothing can read it.
    @Entry var readMessage: (@MainActor (String) async throws -> String)? = nil
    /// Reads an image an answer names (item id, the reference as written); nil leaves images as
    /// their alt text.
    @Entry var readImage: (@MainActor (String, String) async -> UIImage?)? = nil
}

/// Whether an answer is still arriving, and the status VoiceOver hears first on its row while it
/// does. Only the turn's streaming flag, the item's completeness and the bridge's word decide it,
/// never the text, so the status stays the same through every delta and isn't read again as the
/// answer grows.
struct AnswerLiveness: Equatable {
    /// The answer block's text still arrives while its turn runs.
    let streaming: Bool
    let complete: Bool
    /// The bridge's word for it ("Writing", `@ace/ui-core` `answerWritingLabel`).
    let writing: String?
    /// Text left incomplete by a turn that stopped no longer streams.
    var live: Bool { streaming && !complete }
    /// The status element's words while the answer arrives; nil once it is done.
    var status: String? { live ? writing : nil }
}

/// Agent prose as the web draws it: bare full-width Markdown, heard as "Writing" while it streams,
/// and, once finished, its time and Copy under it. An answer longer than its row reads its whole
/// text on its own, saying so while it loads ("Loading full answer…", Try again on failure).
/// What the agent says between its steps (`between`) is plain prose: no time or actions.
struct AnswerRow: View {
    let row: TranscriptRow
    var streaming = false
    /// The bridge's word for an answer still arriving (`BlockRow.writing`).
    var writing: String? = nil
    var between = false
    var openMessage: ((TranscriptRow) -> Void)? = nil
    @Environment(\.readMessage) private var readMessage
    @Environment(\.readImage) private var readImage
    @Environment(\.fileLinks) private var fileLinks
    @Environment(\.colorScheme) private var scheme
    @State private var full: String?
    @State private var problem: String?
    /// Whole answers past this many characters open in the reader instead of the row.
    private static let inline = 200_000
    var body: some View {
        let liveness = AnswerLiveness(streaming: streaming, complete: row.complete, writing: writing)
        let live = liveness.live
        // The status comes first in the tree, so VoiceOver stops on it before the text.
        ZStack(alignment: .topLeading) {
            if let status = liveness.status { statusElement(status) }
            VStack(alignment: .leading, spacing: AceDesign.Space.related) {
                if !shown.isEmpty {
                    let menu = !between && !live
                    AceMarkdown(text: shown, streaming: live, selectable: !menu, resolveImage: images(of: row.id),
                                flavor: AnswerMarkdown.flavor, renderDiagram: AnswerMarkdown.renderDiagram(dark: scheme == .dark))
                        .fileLinks(fileLinks, itemId: row.id)
                        .messageMenu(menu ? shown : "", title: "Answer", row: row, quotable: true)
                }
                if row.truncated && !live && full == nil { partial }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("message.answer.\(row.id)")
        .task(id: row.truncated && row.complete) { await load() }
    }
    /// VoiceOver's first stop on an answer still arriving: markit's text blocks speak their own
    /// text, so the status is its own element ahead of them, drawn as nothing. It exists only while
    /// the answer is live, so it never changes on a delta.
    private func statusElement(_ words: String) -> some View {
        Color.clear
            .frame(width: 1, height: 1)
            .accessibilityElement()
            .accessibilityLabel(words)
            .accessibilityAddTraits(.isStaticText)
            .accessibilitySortPriority(1)
            .accessibilityIdentifier("message.answer.\(row.id).status")
    }
    private var shown: String { full ?? row.text }
    /// Draws an image the answer names from the thread's own captures; nil outside a thread.
    private func images(of itemId: String) -> (@MainActor (String) async -> UIImage?)? {
        guard let readImage else { return nil }
        return { reference in await readImage(itemId, reference) }
    }
    @ViewBuilder private var partial: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            if let problem {
                Text(problem)
                HStack(spacing: AceDesign.Space.row) {
                    if readMessage != nil { Button("Try again") { Task { await load() } } }
                    if let openMessage { Button("Read full message") { openMessage(row) } }
                }
                .fontWeight(AceDesign.Typeface.regular).foregroundStyle(AceTheme.Colours.foreground)
            } else if readMessage != nil {
                Text("Loading full answer…").accessibilityAddTraits(.updatesFrequently)
            } else if let openMessage {
                Button("Read full message") { openMessage(row) }
                    .accessibilityIdentifier("message.full.\(row.id)")
            }
        }
        .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
        .foregroundStyle(AceTheme.Colours.mutedForeground)
    }
    private func load() async {
        guard row.truncated, row.complete, full == nil, let readMessage else { return }
        problem = nil
        do {
            let text = try await readMessage(row.id)
            if text.count > Self.inline { problem = "This answer is too long to show here." } else { full = text }
        } catch {
            if !Task.isCancelled { problem = error.localizedDescription }
        }
    }
}

