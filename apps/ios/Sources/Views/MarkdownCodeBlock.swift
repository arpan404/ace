import SwiftUI

/// A fenced block as the web draws it (DESIGN.md §4 Code): a 32pt header holding the language
/// (or "text") and Copy in the header's quietest ink, a hairline, then SF Mono that scrolls
/// sideways. A block longer than 22 lines shows its first 20 with "Show all N lines" / "Collapse".
struct MarkdownCodeBlock: View {
    let language: String
    let text: String
    @State private var copied = false
    @State private var showAll = false
    private static let cappedAt = 20
    var body: some View {
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
                Text(verbatim: shown).aceMonospace(AceTheme.Typography.code, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.foreground)
                    .fixedSize(horizontal: true, vertical: false).textSelection(.enabled)
                    .padding(.horizontal, AceTheme.Spacing.md).padding(.top, AceTheme.Spacing.sm).padding(.bottom, AceTheme.Spacing.md)
            }
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
        .background(AceTheme.Colours.fill, in: RoundedRectangle(cornerRadius: AceTheme.Radii.lg, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: AceTheme.Radii.lg, style: .continuous).stroke(AceTheme.Colours.separator, lineWidth: AceTheme.Dimensions.border))
        .accessibilityIdentifier("markdown.code")
        .task(id: copied) {
            guard copied else { return }
            do { try await Task.sleep(for: .seconds(1.5)); copied = false } catch { }
        }
    }
}
