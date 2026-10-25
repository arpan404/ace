import SwiftUI

/// Styled runs as one attributed string in the theme's type: bold, italic, struck, underlined,
/// highlighted, code and keys in SF Mono on a fill, raised and lowered text, and links.
@MainActor enum ForgeRichText {
    static func string(_ runs: [ForgeRun], size: CGFloat = AceTheme.Typography.body.size) -> AttributedString {
        var out = AttributedString()
        for run in runs {
            var piece = AttributedString(run.text)
            let small = run.sup == true || run.sub == true
            let base = small ? size * 0.75 : size
            var font: Font = run.code == true || run.kbd == true ? .system(size: base * 0.92, design: .monospaced) : .system(size: base)
            if run.b == true { font = font.weight(.semibold) }
            if run.i == true { font = font.italic() }
            piece.font = font
            if run.code == true || run.kbd == true { piece.backgroundColor = AceTheme.Colours.fill }
            if run.mark == true { piece.backgroundColor = AceTheme.Colours.accent.opacity(0.25) }
            if run.s == true { piece.strikethroughStyle = .single }
            if run.u == true { piece.underlineStyle = .single }
            if run.sup == true { piece.baselineOffset = size * 0.35 }
            if run.sub == true { piece.baselineOffset = -size * 0.2 }
            if let link = run.link, let url = URL(string: link) {
                piece.link = url
                piece.foregroundColor = AceTheme.Colours.accent
            }
            out += piece
        }
        return out
    }
}

/// One line of runs as text, selectable, in body type.
struct ForgeRunsText: View {
    let runs: [ForgeRun]
    var size: CGFloat = AceTheme.Typography.body.size
    var align: String?

    var body: some View {
        Text(ForgeRichText.string(runs, size: size))
            .foregroundStyle(AceTheme.Colours.foreground)
            .multilineTextAlignment(align == "center" ? .center : align == "right" ? .trailing : .leading)
            .frame(maxWidth: .infinity, alignment: align == "center" ? .center : align == "right" ? .trailing : .leading)
            .fixedSize(horizontal: false, vertical: true)
    }
}
