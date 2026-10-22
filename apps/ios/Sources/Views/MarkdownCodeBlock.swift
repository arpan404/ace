import SwiftUI

struct MarkdownCodeBlock: View {
    let language: String
    let text: String
    @State private var copied = false
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            HStack(spacing: AceTheme.Spacing.sm) {
                Text(language.isEmpty ? "Code" : language).lineLimit(1)
                Spacer(minLength: AceTheme.Spacing.sm)
                Button {
                    UIPasteboard.general.string = text
                    copied = true
                } label: {
                    Label(copied ? "Copied" : "Copy", ace: copied ? .check : .copy)
                        .frame(minHeight: AceTheme.Dimensions.touchTarget)
                }
                .buttonStyle(.plain).accessibilityLabel(copied ? "Code copied" : "Copy code")
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
            .padding(.horizontal, AceTheme.Spacing.md)
            Rectangle().fill(AceTheme.Colours.separator).frame(height: AceTheme.Dimensions.border)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(verbatim: text).aceMonospace(AceTheme.Typography.code, relativeTo: .footnote)
                    .fixedSize(horizontal: true, vertical: false).textSelection(.enabled)
                    .padding(AceTheme.Spacing.md)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AceTheme.Colours.fill, in: AceShape.block)
        .overlay(AceShape.block.stroke(AceTheme.Colours.separator, lineWidth: AceTheme.Dimensions.border))
        .task(id: copied) {
            guard copied else { return }
            do { try await Task.sleep(for: .seconds(2)); copied = false } catch { }
        }
    }
}
