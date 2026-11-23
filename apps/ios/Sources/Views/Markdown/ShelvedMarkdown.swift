import Markit
import SwiftUI
import UIKit

extension EnvironmentValues {
    /// The open thread's rendered Markdown, kept while its rows scroll off screen.
    @Entry var markdownShelf: ViewShelf<MarkitInlineView>? = nil
    @Entry var transcriptMarkdown: TranscriptMarkdownPrefetch? = nil
    @Entry var transcriptMarkdownHeights: TranscriptMarkdownHeights? = nil
    @Entry var transcriptShowingHistory = false
    @Entry var markdownOwner: String? = nil
}

/// The shelf is available on first layout, so finished messages mount their renderer once.
private struct MarkdownShelfScope: ViewModifier {
    let heights: TranscriptMarkdownHeights?
    @State private var shelf = ViewShelf<MarkitInlineView>(maxKept: 40)
    @State private var prefetch = TranscriptMarkdownPrefetch()
    func body(content: Content) -> some View {
        content.environment(\.markdownShelf, shelf)
            .environment(\.transcriptMarkdown, prefetch)
            .environment(\.transcriptMarkdownHeights, heights)
    }
}

extension View {
    func markdownShelf(threadId: String, heights: TranscriptMarkdownHeights?) -> some View {
        modifier(MarkdownShelfScope(heights: heights)).id(threadId)
    }
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
    @Environment(\.markdownOwner) var owner
    @Environment(\.transcriptMarkdown) var preparation
    @Environment(\.transcriptMarkdownHeights) var heights
    @Environment(\.transcriptShowingHistory) var history
    @Environment(\.layoutDirection) var layoutDirection
    @Environment(\.transcriptScale) var scale
    @Environment(\.dynamicTypeSize) var typeSize
    /// Only a changed size that SwiftUI has yet to measure asks for layout again.
    @State private var sizeRevision = 0

    var body: some View {
        ShelvedMarkdownHost(markdown: self, sizeRevision: sizeRevision) { sizeRevision &+= 1 }
    }
}

private struct ShelvedMarkdownHost: UIViewRepresentable {
    let markdown: ShelvedMarkdown
    let sizeRevision: Int
    let onSizeChanged: () -> Void

    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        container.backgroundColor = .clear
        return container
    }

    func updateUIView(_ container: UIView, context: Context) {
        let coordinator = context.coordinator
        let remount = coordinator.text != markdown.text || coordinator.flavor != markdown.flavor
            || coordinator.owner != markdown.owner
        var initial = false
        if remount {
            coordinator.release()
            let key = TranscriptMarkdownDocuments.key(markdown.text, flavor: markdown.flavor)
            let view: MarkitInlineView
            if let kept = markdown.shelf.take(key) {
                view = kept
                PerfProbe.add("markdown.reused", 1)
            } else {
                view = MarkitInlineView(theme: markdown.theme, flavor: markdown.flavor)
                initial = true
                PerfProbe.add("markdown.built", 1)
            }
            view.frame = container.bounds
            view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            container.addSubview(view)
            coordinator.show(view, key: key, text: markdown.text, owner: markdown.owner, shelf: markdown.shelf)
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
        view.onContentHeightChange = { [weak view, weak coordinator] height in
            guard let view, let coordinator, coordinator.measurement.needsLayout(height: height, at: view.bounds.width) else { return }
            onSizeChanged()
        }
        if initial {
            if markdown.flavor == .agent, let preparation = markdown.preparation {
                coordinator.renderAnswer(preparation.documents, deferColdRender: markdown.history || preparation.moving)
            } else {
                view.render(markdown.text, finalized: true)
            }
        }
    }

    static func dismantleUIView(_ container: UIView, coordinator: Coordinator) { coordinator.release() }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UIView, context: Context) -> CGSize? {
        let offered = proposal.width ?? 0
        let width = offered > 0 && offered.isFinite ? offered : (uiView.bounds.width > 0 ? uiView.bounds.width : 320)
        let coordinator = context.coordinator
        var height = coordinator.view?.height(for: width) ?? 0
        if markdown.flavor == .agent, let key = coordinator.key {
            let measurementKey = "\(key):\(width):\(markdown.scale):\(markdown.typeSize):\(markdown.layoutDirection)"
            let measured = markdown.shelf.height(measurementKey)
            if height > 0, measured != height {
                markdown.shelf.remember(height: height, for: measurementKey)
                markdown.heights?.remember(measurementKey, height: Double(height))
            } else if coordinator.preparing, height == 0 {
                let persisted = measured == nil ? markdown.heights?.disk.height(for: measurementKey) : nil
                if persisted != nil { PerfProbe.add("markdown.heightDiskHit", 1) }
                let kept = measured ?? persisted.map { CGFloat($0) }
                PerfProbe.add(kept == nil ? "markdown.heightMiss" : "markdown.heightHit", 1)
                height = kept ?? 0
            }
        }
        coordinator.measurement.measured(height: height, at: width)
        return CGSize(width: width, height: height)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    @MainActor final class Coordinator {
        private(set) var view: MarkitInlineView?
        private(set) var key: String?
        private(set) var owner: String?
        private(set) var text: String?
        var flavor: MarkitFlavor? { view?.flavor }
        var measurement = MarkdownMeasurement()
        private var pending: Task<Void, Never>?
        var preparing: Bool { pending != nil }
        private weak var shelf: ViewShelf<MarkitInlineView>?
        func show(_ view: MarkitInlineView, key: String, text: String, owner: String?, shelf: ViewShelf<MarkitInlineView>) {
            self.view = view
            self.key = key
            self.text = text
            self.owner = owner
            measurement = MarkdownMeasurement()
            self.shelf = shelf
            MarkdownGates.gate(for: view).open()
        }
        func renderAnswer(_ documents: TranscriptMarkdownDocuments, deferColdRender: Bool) {
            guard let view, let key, let text else { return }
            if let cached = documents.cached(key) {
                PerfProbe.add("markdown.parseHit", 1)
                view.setDocument(cached)
                return
            }
            PerfProbe.add("markdown.parseMiss", 1)
            // Preserve the immediate first layout of a newly opened thread at its live end.
            guard deferColdRender else { view.render(text, finalized: true); return }
            pending = Task { [weak self, weak view] in
                let document = await documents.document(text, flavor: .agent, key: key)
                guard !Task.isCancelled, let self, let view else { return }
                self.pending = nil
                if let document {
                    view.setDocument(document)
                } else {
                    view.synchronousRenderLimit = -1
                    view.render(text, finalized: true)
                }
            }
        }
        /// The row went off screen (or shows other text): its view goes back on the shelf, and
        /// its diagrams still waiting to be drawn step out of the queue until it shows again.
        func release() {
            guard let view, let key else { return }
            MarkdownGates.gate(for: view).close()
            view.removeFromSuperview()
            view.onContentHeightChange = nil
            view.onLink = nil
            view.onReference = nil
            view.resolveImage = nil
            if !preparing { shelf?.put(view, for: key, owner: owner) }
            pending?.cancel()
            pending = nil
            self.view = nil
            self.key = nil
            self.text = nil
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
