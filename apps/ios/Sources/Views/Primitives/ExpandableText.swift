import SwiftUI

/// Words that may be longer than their row: cut at `lines` with More at the end; a tap on them
/// or on More opens the rest in place, and Less (or another tap) folds it again. Long-press
/// copies the whole text. Words that fit show as plain text and offer nothing.
///
/// What was opened is kept by `id` in the screen's `expansions` (the thread's folds in a
/// transcript, so the feed holds the reader's place as it grows), and survives the row
/// scrolling away. The caller styles it like `Text`: font and ink come from the environment.
struct ExpandableText: View {
    let text: String
    let id: String
    var lines = 2
    var copies = true
    private let fold: RowFold
    @Environment(\.aceReduceMotion) private var reduceMotion
    @State private var shown: CGFloat = 0
    @State private var full: CGFloat = 0

    init(_ text: String, id: String, lines: Int = 2, copies: Bool = true) {
        self.text = text
        self.id = id
        self.lines = lines
        self.copies = copies
        fold = RowFold(id)
    }

    private var open: Bool { fold.isOpen }
    private var clipped: Bool { full > shown + 1 }
    private var affordance: TextExpansion.Affordance? { TextExpansion.affordance(open: open, clipped: clipped) }

    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            Text(text)
                .lineLimit(open ? nil : lines)
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { shown = $0 }
                // The whole text at the same width, never drawn: whether the shown one is cut.
                .background(alignment: .topLeading) {
                    // Its own limit: an outer `lineLimit` (a row's `meta()`) must not cut the measure.
                    Text(text).lineLimit(nil).fixedSize(horizontal: false, vertical: true).hidden()
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { full = $0 }
                }
                .contentShape(Rectangle())
                .onTapGesture { toggle() }
                .allowsHitTesting(affordance != nil)
            if let affordance {
                Button(affordance == .more ? "More" : "Less", action: toggle)
                    .buttonStyle(.plain)
                    .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .frame(minHeight: AceDesign.Size.tap / 2)
                    .accessibilityHidden(true)
            }
        }
        .contextMenu {
            if copies { Button("Copy", ace: .copy) { UIPasteboard.general.string = text } }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(text)
        .accessibilityActions {
            if let affordance { Button(affordance == .more ? "Show more" : "Show less", action: toggle) }
        }
    }

    private func toggle() {
        withAnimation(reduceMotion ? nil : .default) { fold.toggle() }
    }
}
