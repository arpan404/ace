import SwiftUI

/// A Markdown file drawn as it reads, both sides through the daemon: each block (a paragraph,
/// a heading, a list, a code block) kept, removed or added, the changed ones tinted and marked
/// with − or + (and read aloud as Removed or Added). Blocks are lazy rows.
struct ForgeRenderedDiffView: View {
    let client: ClientModel
    let route: ForgeRoute
    let scope: ForgeRichScope
    @State private var blocks: [ForgeFileSides.Block]?
    @State private var hidden = 0
    @State private var failure: String?

    var body: some View {
        Group {
            if let blocks {
                LazyVStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                    ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                        row(block).accessibilityIdentifier("forge.rendered.\(index)")
                    }
                    if hidden > 0 {
                        Text("\(hidden) more blocks on GitHub").meta()
                            .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.md)
                    }
                }
                .padding(.vertical, AceTheme.Spacing.sm)
                .transition(.opacity)
            } else if let failure {
                EmptyState(icon: nil, title: "Couldn't draw this file", line: failure, failed: true) {
                    Button("Try again") { Task { await load() } }
                }
                .padding(.top, 60)
            } else {
                ProgressView().padding(.top, 60).frame(maxWidth: .infinity)
            }
        }
        .animation(.smooth, value: blocks == nil)
        .task(id: route) { await load() }
    }

    private func row(_ block: ForgeFileSides.Block) -> some View {
        HStack(alignment: .top, spacing: AceTheme.Spacing.sm) {
            Text(verbatim: block.kind == "add" ? "+" : block.kind == "del" ? "−" : "")
                .aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
                .foregroundStyle(AceTheme.Colours.subtleForeground)
                .frame(width: 12, alignment: .leading)
                .accessibilityHidden(true)
            ForgeRichView(blocks: block.blocks, scope: scope)
        }
        .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.xs)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(block.kind == "add" ? AceTheme.Colours.diffAdd : block.kind == "del" ? AceTheme.Colours.diffDelete : .clear)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(block.kind == "add" ? "Added" : block.kind == "del" ? "Removed" : "")
    }

    private func load() async {
        do {
            guard case .rendered(let read, let more) = try await client.forgeFileSides(route, as: "rendered") else { return }
            blocks = read
            hidden = more
            failure = nil
        } catch is CancellationError {
        } catch { failure = error.localizedDescription }
    }
}
