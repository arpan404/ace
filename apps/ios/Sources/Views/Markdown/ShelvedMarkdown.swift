import Markit
import SwiftUI
import UIKit

extension EnvironmentValues {
    /// The open thread's rendered Markdown, kept while its rows scroll off screen.
    @Entry var markdownShelf: ViewShelf<MarkitInlineView>? = nil
}

/// Keeps one thread's rendered Markdown: a finished message scrolled back into view gets the
/// view markit already built for it instead of building every text view again. One shelf per
/// thread, like its published media.
struct MarkdownShelfScope: ViewModifier {
    let threadId: String
    @State private var kept: Kept?
    @MainActor private final class Kept {
        let threadId: String
        let shelf = ViewShelf<MarkitInlineView>(maxKept: 40)
        init(threadId: String) { self.threadId = threadId }
    }
    func body(content: Content) -> some View {
        content
            .environment(\.markdownShelf, kept?.threadId == threadId ? kept?.shelf : nil)
            .task(id: threadId) { if kept?.threadId != threadId { kept = Kept(threadId: threadId) } }
    }
}

extension View {
    func markdownShelf(threadId: String) -> some View { modifier(MarkdownShelfScope(threadId: threadId)) }
}

/// Finished Markdown drawn by a view from the thread's shelf when it has one for this text,
/// through markit's public `MarkitInlineView`. It takes the width offered and the height its
/// content needs, as `MarkitInline` does.
struct ShelvedMarkdown: View {
    let text: String
    let flavor: MarkitFlavor
    let theme: MarkitTheme
    let selectable: Bool
    let codeCollapse: MarkitCodeCollapse?
    let onLink: (URL) -> Void
    let onReference: (MarkitReference) -> Void
    let resolveImage: (@MainActor (String) async -> UIImage?)?
    let onTask: ((MarkitTask) -> Void)?
    let renderDiagram: (@MainActor (_ language: String, _ source: String) async -> UIView?)?
    let shelf: ViewShelf<MarkitInlineView>
    /// The height the view last reported: a change makes SwiftUI measure the row again.
    @State private var height: CGFloat?

    var body: some View {
        ShelvedMarkdownHost(markdown: self, measured: height) { height = $0 }
    }

    /// What identifies this rendering on the shelf: the text and the dialect it is read in.
    var key: String { "\(flavor.rawValue):" + contentKey(text) }
}

private struct ShelvedMarkdownHost: UIViewRepresentable {
    let markdown: ShelvedMarkdown
    let measured: CGFloat?
    let onHeight: (CGFloat) -> Void

    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        container.backgroundColor = .clear
        return container
    }

    func updateUIView(_ container: UIView, context: Context) {
        let coordinator = context.coordinator
        let key = markdown.key
        if coordinator.key != key {
            coordinator.release()
            let view: MarkitInlineView
            if let kept = markdown.shelf.take(key) {
                view = kept
                PerfProbe.add("markdown.reused", 1)
            } else {
                view = MarkitInlineView(theme: markdown.theme, flavor: markdown.flavor)
                PerfProbe.add("markdown.built", 1)
            }
            view.frame = container.bounds
            view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            container.addSubview(view)
            coordinator.show(view, key: key, shelf: markdown.shelf)
        }
        guard let view = coordinator.view else { return }
        view.theme = markdown.theme
        view.flavor = markdown.flavor
        view.isTextSelectable = markdown.selectable
        view.codeCollapse = markdown.codeCollapse
        view.onLink = markdown.onLink
        view.onReference = markdown.onReference
        view.resolveImage = markdown.resolveImage
        view.onTask = markdown.onTask
        view.renderDiagram = MarkdownGates.gated(markdown.renderDiagram, for: view)
        view.onContentHeightChange = onHeight
        view.render(markdown.text, finalized: true)
    }

    static func dismantleUIView(_ container: UIView, coordinator: Coordinator) { coordinator.release() }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UIView, context: Context) -> CGSize? {
        let offered = proposal.width ?? 0
        let width = offered > 0 && offered.isFinite ? offered : (uiView.bounds.width > 0 ? uiView.bounds.width : 320)
        return CGSize(width: width, height: context.coordinator.view?.height(for: width) ?? 0)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    @MainActor final class Coordinator {
        private(set) var view: MarkitInlineView?
        private(set) var key: String?
        private weak var shelf: ViewShelf<MarkitInlineView>?
        func show(_ view: MarkitInlineView, key: String, shelf: ViewShelf<MarkitInlineView>) {
            self.view = view
            self.key = key
            self.shelf = shelf
            MarkdownGates.gate(for: view).open()
        }
        /// The row went off screen (or shows other text): its view goes back on the shelf, and
        /// its diagrams still waiting to be drawn step out of the queue until it shows again.
        func release() {
            guard let view, let key else { return }
            MarkdownGates.gate(for: view).close()
            view.removeFromSuperview()
            view.onContentHeightChange = nil
            shelf?.put(view, for: key)
            self.view = nil
            self.key = nil
        }
    }
}

/// One `RenderGate` per shelved markit view, for as long as the view lives: its diagrams draw
/// only while it is on screen.
@MainActor enum MarkdownGates {
    private static let gates = NSMapTable<MarkitInlineView, RenderGate>.weakToStrongObjects()

    static func gate(for view: MarkitInlineView) -> RenderGate {
        if let gate = gates.object(forKey: view) { return gate }
        let gate = RenderGate()
        gates.setObject(gate, forKey: view)
        return gate
    }

    /// The view's diagram drawing, through its gate.
    static func gated(_ draw: (@MainActor (_ language: String, _ source: String) async -> UIView?)?,
                      for view: MarkitInlineView) -> (@MainActor (_ language: String, _ source: String) async -> UIView?)? {
        guard let draw else { return nil }
        let gate = gate(for: view)
        return { language, source in await gate.run { await draw(language, source) } }
    }
}
