import Markit
import SwiftUI

/// Markdown as ace draws it everywhere: markit's native rendering (CommonMark,
/// tables, task lists, code blocks with grammar colours, Copy and a "Show all" fold past 22 lines,
/// diff fences, inline and display math) in ace's look (`AceMarkdownTheme`). It takes the width it
/// is offered and the height its content needs.
///
/// A streaming message reaches markit at a steady pace (`StreamPace`) rather than on every delta,
/// and markit reparses only its open last blocks; finished text shows at once. Links open through
/// the environment's `openURL` (a thread routes local links to its files, `fileLinks`); a file
/// reference opens as such a link. Forge text (`ForgeText`) uses GitHub's flavour with its own
/// link rules (`route`), ticks task boxes (`onTask`) and draws diagrams (`renderDiagram`).
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
    /// `.github` for pull request, issue and comment bodies.
    var flavor: MarkitFlavor = .standard
    /// GitHub flavour: a task box was tapped; nil shows boxes without letting them tick.
    var onTask: ((MarkitTask) -> Void)? = nil
    /// GitHub flavour: draws a closed diagram fence; nil (or a nil view) keeps its code.
    var renderDiagram: (@MainActor (_ language: String, _ source: String) async -> UIView?)? = nil
    /// Where links and references go instead of straight to `openURL`; nil returned leaves the
    /// tap inert.
    var route: MarkdownRoute? = nil

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
        let route = route
        MarkitInline(markdown: streaming ? (paced ?? text) : text, finalized: !streaming, flavor: flavor,
                     theme: AceMarkdownTheme.current(scale: scale, tone: tone),
                     isTextSelectable: selectable, codeCollapse: Self.collapse,
                     onLink: { url in
                         if let route { if let target = route.link(url) { open(target) } } else { open(url) }
                     },
                     onReference: { reference in
                         if let route { if let target = route.reference(reference) { open(target) } } else { open(Self.url(for: reference)) }
                     },
                     resolveImage: resolveImage, onTask: onTask, renderDiagram: renderDiagram)
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
            // Off screen the timer stops; back on screen the newest text that arrived meanwhile
            // shows (or waits its turn), never the text left from before.
            .onAppear {
                guard streaming else { return }
                take(pace.due(now: Self.now(), late: 0))
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

/// Where taps in a piece of Markdown go: each link or reference to the address it opens, nil to
/// leave it inert.
struct MarkdownRoute {
    let link: (URL) -> URL?
    let reference: (MarkitReference) -> URL?
}
