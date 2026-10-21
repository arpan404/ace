import SwiftUI

/// A fenced code block, kept quiet: one soft fill, the language in small grey type with a bare
/// copy glyph beside it, and the code in SF Mono that scrolls sideways. While a line runs on past
/// the edge, the edge fades instead of cutting a character in half.
struct MarkdownCodeBlock: View {
    let language: String
    let text: String
    @State private var copied = false
    /// The code continues past the trailing edge.
    @State private var runsOn = false
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            HStack(spacing: AceTheme.Spacing.sm) {
                Text(language).lineLimit(1)
                Spacer(minLength: AceTheme.Spacing.sm)
                Button(action: copy) {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .frame(width: AceTheme.Dimensions.touchTarget, height: AceTheme.Dimensions.touchTarget)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                // The glyph keeps a full touch target without making the row tall.
                .padding(.vertical, -AceTheme.Spacing.sm)
                .accessibilityLabel(copied ? "Code copied" : "Copy code")
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
            .foregroundStyle(AceTheme.Colours.subtleForeground)
            .frame(minHeight: AceTheme.Spacing.xxxl)
            .padding(.leading, AceTheme.Spacing.md)
            ScrollView(.horizontal) {
                Text(verbatim: text).aceMonospace(AceTheme.Typography.code, relativeTo: .footnote)
                    .fixedSize(horizontal: true, vertical: false).textSelection(.enabled)
                    .padding(.horizontal, AceTheme.Spacing.md).padding(.bottom, AceTheme.Spacing.md)
            }
            .scrollIndicators(.hidden)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentSize.width - geometry.contentOffset.x - geometry.containerSize.width > AceTheme.Dimensions.border
            } action: { _, more in runsOn = more }
            .mask {
                HStack(spacing: AceTheme.Spacing.none) {
                    Rectangle()
                    LinearGradient(colors: [.black, .black.opacity(runsOn ? 0 : 1)], startPoint: .leading, endPoint: .trailing)
                        .frame(width: AceTheme.Spacing.xxl)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AceTheme.Colours.fill, in: RoundedRectangle(cornerRadius: AceTheme.Radii.code, style: .continuous))
        .contextMenu { Button("Copy code", systemImage: "doc.on.doc", action: copy) }
        .sensoryFeedback(.success, trigger: copied) { _, now in now }
        .task(id: copied) {
            guard copied else { return }
            do { try await Task.sleep(for: .seconds(2)); copied = false } catch { }
        }
    }
    private func copy() {
        UIPasteboard.general.string = text
        copied = true
    }
}
