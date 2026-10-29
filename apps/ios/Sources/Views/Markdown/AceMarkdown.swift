import Markit
import SwiftUI

/// Markdown as ace draws it everywhere outside forge text: markit's native rendering (CommonMark,
/// tables, task lists, code blocks with grammar colours, Copy and a "Show all" fold past 22 lines,
/// diff fences, inline and display math) in ace's look (`AceMarkdownTheme`). It takes the width it
/// is offered and the height its content needs.
///
/// A streaming message reaches markit at a steady pace (`StreamPace`) rather than on every delta,
/// and markit reparses only its open last blocks; finished text shows at once. Links open through
/// the environment's `openURL` (a thread routes local links to its files, `fileLinks`); a file
/// reference opens as such a link.
struct AceMarkdown: View {
    let text: String
    /// Still arriving: updates are paced, and the open last block may change.
    var streaming = false
    /// Off where the message's own long-press menu offers Copy and Select text instead: text
    /// selection would take the long press from it. Links still open.
    var selectable = true
    var tone: AceMarkdownTheme.Tone = .body
    /// Draws an image the text names; nil leaves images as their alt text.
    var resolveImage: (@MainActor (String) async -> UIImage?)? = nil

    @Environment(\.openURL) private var openURL
    @Environment(\.transcriptScale) private var scale
    @Environment(\.aceReduceMotion) private var reduceMotion
    @State private var pace = StreamPace()
    /// What the pace last drew while streaming; nil once the text is finished.
    @State private var paced: String?
    @State private var wake: Task<Void, Never>?

    /// The web's rule (DESIGN.md §4 Code): a block past 22 lines shows its first 20 until opened.
    static let collapse = MarkitCodeCollapse(collapseAbove: 22, visibleLines: 20)

    var body: some View {
        let open = openURL
        MarkitInline(markdown: streaming ? (paced ?? text) : text, finalized: !streaming,
                     theme: AceMarkdownTheme.current(scale: scale, tone: tone),
                     isTextSelectable: selectable, codeCollapse: Self.collapse,
                     onLink: { open($0) },
                     onReference: { open(Self.url(for: $0)) },
                     resolveImage: resolveImage)
            .frame(maxWidth: .infinity, alignment: .leading)
            .onChange(of: text, initial: true) { _, latest in
                guard streaming else { return }
                pace.reduceMotion = reduceMotion
                take(pace.push(latest, now: Self.now()))
            }
            .onChange(of: streaming) { _, live in
                guard !live else { return }
                stop()
                _ = pace.finish(text)
                paced = nil
            }
            .onDisappear { stop() }
    }

    /// A file reference opens as the link it would be written as (`fileLinks` asks the thread);
    /// anything else as its target.
    static func url(for reference: MarkitReference) -> URL {
        let target = reference.target
        let encoded = target.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? target
        if reference.kind == "file" { return URL(string: encoded) ?? URL(fileURLWithPath: target) }
        return URL(string: target) ?? URL(string: encoded) ?? URL(fileURLWithPath: target)
    }

    private func take(_ step: StreamPace.Step) {
        switch step {
        case .show(let text):
            paced = text
        case .wait(let delay):
            guard wake == nil else { return }
            let due = Self.now() + delay
            wake = Task { @MainActor in
                try? await Task.sleep(for: .seconds(delay))
                guard !Task.isCancelled else { return }
                wake = nil
                let now = Self.now()
                take(pace.due(now: now, late: max(0, now - due)))
            }
        case .idle:
            break
        }
    }

    private func stop() {
        wake?.cancel()
        wake = nil
    }

    /// Seconds on the monotonic clock; only the pace's shell reads it.
    private static func now() -> TimeInterval { ProcessInfo.processInfo.systemUptime }
}

extension AceMarkdown {
    /// `text` as one fenced code block in `language`: its fence is longer than any run of
    /// backticks inside it, so the text can never close it early.
    static func fenced(_ text: String, language: String) -> String {
        var longest = 0, run = 0
        for character in text {
            run = character == "`" ? run + 1 : 0
            longest = max(longest, run)
        }
        let fence = String(repeating: "`", count: max(3, longest + 1))
        let info = language.filter { !$0.isWhitespace && $0 != "`" }
        return "\(fence)\(info)\n\(text)\n\(fence)"
    }
}
