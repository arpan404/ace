import SwiftUI

/// Lines picked for a new comment: one line, or a span on one side of one change (the bridge
/// numbers each line's change; lines there are numbered without gaps, so GitHub takes any span).
struct ForgeLinePick: Equatable {
    let hunk: Int
    /// `LEFT` (the old side) or `RIGHT`.
    let side: String
    /// The line first tapped; the span runs from it to the line extended to.
    let origin: Int
    var start: Int
    var end: Int
    /// The next tap on a line of the same change sets the span's other end.
    var extending = false

    init(hunk: Int, anchor: ForgeFileDiff.Anchor) {
        self.hunk = hunk
        side = anchor.side
        origin = anchor.line
        start = anchor.line
        end = anchor.line
    }

    /// Whether `line` lies inside the span, by its number on the picked side.
    func holds(_ line: ForgeFileDiff.Line) -> Bool {
        guard line.hunk == hunk, let number = side == "LEFT" ? line.old : line.new else { return false }
        if side == "LEFT", line.kind == "add" { return false }
        if side == "RIGHT", line.kind == "del" { return false }
        return (start...end).contains(number)
    }

    /// Extends the span to `anchor`; false when it is on another side or change.
    mutating func extend(to anchor: ForgeFileDiff.Anchor, hunk other: Int) -> Bool {
        guard other == hunk, anchor.side == side else { return false }
        start = min(origin, anchor.line)
        end = max(origin, anchor.line)
        extending = false
        return true
    }

    var label: String {
        let old = side == "LEFT" ? "old " : ""
        return start == end ? "\(old)line \(end)".capitalizedFirst : "\(old)lines \(start)–\(end)".capitalizedFirst
    }

    /// Where a comment on the span anchors, as the bridge's review write takes it.
    func anchor(path: String, commit: String) -> [String: Any] {
        var place: [String: Any] = ["commit": commit, "path": path, "line": end, "side": side]
        if start < end {
            place["startLine"] = start
            place["startSide"] = side
        }
        return place
    }
}

private extension String {
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}

/// The strip under the diff while lines are picked: which lines, Select more (then the last
/// line), Comment and Clear. Plain glass, a capsule.
struct ForgeLinePickStrip: View {
    let pick: ForgeLinePick
    /// Why the last tap couldn't extend the span.
    let note: String?
    let extend: () -> Void
    let comment: () -> Void
    let clear: () -> Void

    var body: some View {
        HStack(spacing: AceTheme.Spacing.md) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                Text(pick.label).aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                    .foregroundStyle(AceTheme.Colours.foreground)
                    .monospacedDigit()
                    .contentTransition(.numericText())
                    .accessibilityIdentifier("forge.pick.label")
                if let line = note ?? (pick.extending ? "Tap the last line" : nil) {
                    Text(line).meta().transition(.opacity)
                }
            }
            Spacer(minLength: AceTheme.Spacing.sm)
            Button(action: extend) {
                // Both words hold the slot at the wider one's size, so the swap fades in place.
                ZStack(alignment: .trailing) {
                    Text("Select more").hidden()
                    Text(pick.extending ? "Done" : "Select more").contentTransition(.opacity)
                }
            }
            .accessibilityLabel(pick.extending ? "Done" : "Select more")
            .accessibilityIdentifier("forge.pick.extend")
            Button("Clear", action: clear)
                .accessibilityIdentifier("forge.pick.clear")
            Button("Comment", action: comment)
                .fontWeight(.semibold)
                .accessibilityIdentifier("forge.pick.comment")
        }
        .buttonStyle(.forgeWord)
        .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
        .padding(.horizontal, AceTheme.Spacing.lg)
        .frame(minHeight: 52)
        .aceGlass(in: AceShape.capsule)
        .padding(.horizontal, AceTheme.Spacing.md)
        .padding(.bottom, AceTheme.Spacing.sm)
        .animation(AceMotion.smooth, value: pick)
        .animation(AceMotion.smooth, value: note)
    }
}
