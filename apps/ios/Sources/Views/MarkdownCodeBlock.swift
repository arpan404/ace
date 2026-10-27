import SwiftUI

/// A fenced block as the web draws it (DESIGN.md §4 Code): a 32pt header holding the language
/// (or "text") and Copy in the header's quietest ink, a hairline, then SF Mono that scrolls
/// sideways. A block longer than 22 lines shows its first 20 with "Show all N lines" / "Collapse".
struct MarkdownCodeBlock: View {
    let language: String
    let text: String
    @Environment(\.markdownRich) private var rich
    @Environment(\.markdownSettled) private var settled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var copied = false
    @State private var showAll = false
    @State private var loaded: MarkdownRich.Code?
    private static let cappedAt = 20
    /// Colours or diff lines once read; a kept read shows on the first frame, so nothing pops.
    private var extras: MarkdownRich.Code? { loaded ?? rich?.knownCode(language.lowercased(), text) }
    var body: some View {
        if language.lowercased() == "math" { MathBlock(text: text) } else { block }
    }
    @ViewBuilder private var block: some View {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        let long = lines.count > Self.cappedAt + 2
        let shown = long && !showAll ? lines.prefix(Self.cappedAt).joined(separator: "\n") : text
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            HStack(spacing: AceTheme.Spacing.sm) {
                Text(verbatim: language.isEmpty ? "text" : language).monospaced().lineLimit(1)
                Spacer(minLength: AceTheme.Spacing.sm)
                Button {
                    UIPasteboard.general.string = text
                    copied = true
                } label: {
                    HStack(spacing: AceTheme.Spacing.xs) {
                        AceIcon(copied ? .check : .copy, size: 13, relativeTo: .caption)
                        Text(copied ? "Copied" : "Copy")
                    }
                    .foregroundStyle(copied ? AceTheme.Colours.foreground : AceTheme.Colours.subtleForeground)
                    .padding(.horizontal, AceTheme.Spacing.sm + AceTheme.Spacing.xxs)
                    .frame(minHeight: AceTheme.Spacing.xxxl)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain).accessibilityLabel(copied ? "Copied" : "Copy code")
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
            .foregroundStyle(AceTheme.Colours.subtleForeground)
            .padding(.leading, AceTheme.Spacing.md).padding(.trailing, AceTheme.Spacing.xs)
            Rectangle().fill(AceTheme.Colours.separator).frame(height: AceTheme.Dimensions.border)
            ScrollView(.horizontal, showsIndicators: false) {
                if let diff = extras?.diff {
                    DiffLines(lines: long && !showAll ? Array(diff.prefix(Self.cappedAt)) : diff)
                        .padding(.top, AceTheme.Spacing.sm).padding(.bottom, AceTheme.Spacing.md)
                } else {
                    Group {
                        if let extras, !extras.runs.isEmpty { Text(MarkdownRich.coloured(shown, extras)) }
                        else { Text(verbatim: shown) }
                    }
                    .aceMonospace(AceTheme.Typography.code, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.foreground)
                    .fixedSize(horizontal: true, vertical: false).textSelection(.enabled)
                    .padding(.horizontal, AceTheme.Spacing.md).padding(.top, AceTheme.Spacing.sm).padding(.bottom, AceTheme.Spacing.md)
                }
            }
            // Colours arrive over the same glyphs: they fade in, the block never moves.
            .animation(reduceMotion ? nil : .smooth, value: loaded)
            if long {
                Rectangle().fill(AceTheme.Colours.separator).frame(height: AceTheme.Dimensions.border)
                Button(showAll ? "Collapse" : "Show all \(lines.count) lines") { showAll.toggle() }
                    .buttonStyle(.plain)
                    .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .frame(maxWidth: .infinity, minHeight: AceTheme.Spacing.xxxl, alignment: .leading)
                    .padding(.horizontal, AceTheme.Spacing.md)
                    .contentShape(Rectangle())
                    .accessibilityValue(showAll ? "Expanded" : "Collapsed")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AceTheme.Colours.fill, in: AceShape.block)
        .overlay(AceShape.block.stroke(AceTheme.Colours.separator, lineWidth: AceTheme.Dimensions.border))
        .accessibilityIdentifier("markdown.code")
        .task(id: copied) {
            guard copied else { return }
            do { try await Task.sleep(for: .seconds(1.5)); copied = false } catch { }
        }
        // Coloured only once the answer has stopped streaming, and only when it comes into view.
        .task(id: settled ? text : "") {
            guard settled, loaded == nil, let rich, rich.knownCode(language.lowercased(), text) == nil else { return }
            loaded = await rich.code(language.lowercased(), text)
        }
        .sensoryFeedback(.success, trigger: copied) { _, now in now }
    }
}

/// A diff fence: added and removed lines tinted across the block with a bar at their edge, hunk
/// headers muted, as the web's diff body reads. VoiceOver says which lines were added or removed.
private struct DiffLines: View {
    let lines: [MarkdownRich.Code.Line]
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                Text(verbatim: line.text.isEmpty ? " " : line.text)
                    .aceMonospace(AceTheme.Typography.code, relativeTo: .footnote)
                    .foregroundStyle(line.kind == "hunk" || line.kind == "meta" ? AceTheme.Colours.mutedForeground : AceTheme.Colours.foreground)
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(.horizontal, AceTheme.Spacing.md)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(tint(line.kind))
                    .overlay(alignment: .leading) { bar(line.kind).frame(width: 2) }
                    .accessibilityLabel(line.kind == "add" ? "Added: \(line.text)" : line.kind == "del" ? "Removed: \(line.text)" : line.text)
            }
        }
        .textSelection(.enabled)
    }
    private func tint(_ kind: String) -> Color {
        switch kind {
        case "add": AceTheme.Colours.diffAdd
        case "del": AceTheme.Colours.diffDelete
        default: .clear
        }
    }
    private func bar(_ kind: String) -> Color {
        switch kind {
        case "add": AceTheme.Status.done
        case "del": AceTheme.Status.failed
        default: .clear
        }
    }
}

/// Display math, as text (`@ace/ui-core` `texText`): centred in the prose's own face, scrolling
/// sideways when it is wider than the column.
private struct MathBlock: View {
    let text: String
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(verbatim: text)
                .font(.system(.body, design: .serif).italic())
                .foregroundStyle(AceTheme.Colours.foreground)
                .fixedSize(horizontal: true, vertical: false)
                .textSelection(.enabled)
                .padding(.vertical, AceTheme.Spacing.xs)
        }
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("markdown.math")
    }
}
