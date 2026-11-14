import SwiftUI
import UIKit

/// A published visualization at full size: full screen over the thread on a phone, a tab of the
/// side panel on iPad, as the web opens one beside the conversation. It is a second live copy of
/// the page: its scripts run and its controls answer, in the same opaque-origin sandbox as the
/// reply's. It draws from the thread's kept copy (`PublishedMediaSource`), so it opens without
/// another read, and it follows the app's appearance: switching to dark reads the page themed for
/// it, keeping the old one on screen until it arrives. Its title follows the item's. Copy source
/// copies the page as the agent wrote it.
struct VisualizationScreen: View {
    let thread: ThreadModel
    let itemId: String
    /// The title it was opened with, used while the thread doesn't hold the item.
    let title: String
    @Environment(\.publishedMedia) private var source
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss
    @State private var page: CanvasPage?
    @State private var failed = false
    @State private var attempt = 0
    @State private var copied = false

    private var shownTitle: String {
        let live = thread.items[itemId]?.row.text ?? ""
        return live.isEmpty ? title : live
    }

    var body: some View {
        Group {
            if let page {
                SandboxedCanvas(document: page.document)
                    .padding(.horizontal, AceDesign.Space.margin)
                    .accessibilityLabel(shownTitle)
            } else if failed {
                EmptyState(icon: .chartBarHorizontal, title: "Couldn't load this visualization", failed: true) {
                    Button("Try again") { failed = false; attempt += 1 }.buttonStyle(.textAction())
                }
                .frame(maxHeight: .infinity)
            } else {
                SkeletonPage(label: "Loading visualization")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Its own element holding the page, so the page's web view keeps its identifier.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("visualization.screen")
        .background(AceTheme.Colours.background)
        .modifier(PageTitle(title: shownTitle, subtitle: ""))
        .navigationBarTitleDisplayMode(.inline)
        .modifier(CloseOutsidePanel())
        .screenBar {
            Button {
                guard let text = page?.source, !text.isEmpty else { return }
                UIPasteboard.general.string = text
                copied = true
            } label: {
                AceIcon(copied ? .check : .copy, size: AceDesign.Size.icon)
            }
            .disabled((page?.source ?? "").isEmpty)
            .accessibilityLabel(copied ? "Copied" : "Copy source")
            .accessibilityIdentifier("visualization.copy")
        }
        .sheetEscape { dismiss() }
        .sensoryFeedback(.success, trigger: copied) { _, now in now }
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(2))
            if !Task.isCancelled { copied = false }
        }
        .task(id: "\(itemId)|\(scheme == .dark ? "dark" : "light")|\(attempt)|\(source != nil)") { await load() }
    }

    private func load() async {
        guard let source else { return }
        if case .page(let kept) = source.cached(itemId, scheme: scheme) {
            page = kept
            failed = false
            return
        }
        do {
            if case .page(let read) = try await source.load(itemId, scheme: scheme) {
                page = read
                failed = false
            } else {
                failed = true
            }
        } catch {
            if !Task.isCancelled && page == nil { failed = true }
        }
    }
}

/// Full screen it closes from its own bar; as a panel tab the tab strip closes it.
private struct CloseOutsidePanel: ViewModifier {
    @Environment(\.panelHost) private var panelHost
    func body(content: Content) -> some View {
        if panelHost == nil {
            content.toolbar { SheetClose() }
        } else {
            content
        }
    }
}
