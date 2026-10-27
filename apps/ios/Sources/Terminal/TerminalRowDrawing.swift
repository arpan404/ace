import CoreText
import UIKit

/// The monospaced faces and the cell grid they set.
struct TerminalFonts {
    let size: CGFloat
    let regular: CTFont
    let bold: CTFont
    let italic: CTFont
    let boldItalic: CTFont
    let cellWidth: CGFloat
    let lineHeight: CGFloat
    let ascent: CGFloat

    init(size: CGFloat) {
        self.size = size
        let base = UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
        let heavy = UIFont.monospacedSystemFont(ofSize: size, weight: .bold)
        let slanted = { (font: UIFont) -> UIFont in
            font.fontDescriptor.withSymbolicTraits(.traitItalic).map { UIFont(descriptor: $0, size: size) } ?? font
        }
        regular = base as CTFont
        bold = heavy as CTFont
        italic = slanted(base) as CTFont
        boldItalic = slanted(heavy) as CTFont
        var glyph = CGGlyph()
        var character: UniChar = 0x4D // M
        CTFontGetGlyphsForCharacters(regular, &character, &glyph, 1)
        var advance = CGSize.zero
        CTFontGetAdvancesForGlyphs(regular, .horizontal, &glyph, &advance, 1)
        cellWidth = advance.width > 0 ? advance.width : size * 0.6
        ascent = CTFontGetAscent(regular)
        lineHeight = ceil(CTFontGetAscent(regular) + CTFontGetDescent(regular) + size * 0.28)
    }

    func font(_ flags: TerminalFlags) -> CTFont {
        switch (flags.contains(.bold), flags.contains(.italic)) {
        case (true, true): boldItalic
        case (true, false): bold
        case (false, true): italic
        case (false, false): regular
        }
    }
}

/// One row ready to draw: background spans, text runs placed on the grid, and lines for
/// underline, strike and overline. Built once per change of the row's cells.
struct TerminalRowDrawing {
    struct Span { let column: Int; let width: Int; let colour: CGColor }
    struct Run { let column: Int; let line: CTLine }
    struct Rule { let column: Int; let width: Int; let colour: CGColor; let kind: TerminalFlags }
    let cells: [TerminalCell]
    let marks: [Int: String]
    let spans: [Span]
    let runs: [Run]
    let rules: [Rule]

    init(line: TerminalLine, palette: TerminalPalette, fonts: TerminalFonts, reverse: Bool) {
        cells = line.cells
        marks = line.marks
        var spans: [Span] = []
        var runs: [Run] = []
        var rules: [Rule] = []
        var runText = String.UnicodeScalarView()
        var runStart = 0
        var runStyle: TerminalStyle?

        func colours(_ style: TerminalStyle) -> (CGColor, CGColor?) {
            var foreground = palette.resolve(style.foreground, background: false) ?? palette.foreground
            var background = palette.resolve(style.background, background: true)
            if style.flags.contains(.inverse) != reverse {
                let swapped = background ?? palette.background
                background = style.foreground.isDefault ? palette.foreground : foreground
                foreground = swapped
            }
            if style.flags.contains(.faint) { foreground = foreground.copy(alpha: 0.6) ?? foreground }
            return (foreground, background)
        }
        func flush() {
            guard let style = runStyle, runText.contains(where: { $0.value > 0x20 }) else { runText = String.UnicodeScalarView(); return }
            let (foreground, _) = colours(style)
            let attributes: [CFString: Any] = [kCTFontAttributeName: fonts.font(style.flags), kCTForegroundColorAttributeName: foreground]
            let text = CFAttributedStringCreate(nil, String(runText) as CFString, attributes as CFDictionary)
            if let text { runs.append(Run(column: runStart, line: CTLineCreateWithAttributedString(text))) }
            runText = String.UnicodeScalarView()
        }

        var column = 0
        while column < cells.count {
            let cell = cells[column]
            let flags = cell.style.flags
            if flags.contains(.wideTrail) { column += 1; continue }
            let width = flags.contains(.wide) ? 2 : 1
            var style = cell.style
            style.flags.remove(.placement)
            let (foreground, background) = colours(style)
            if let background {
                if let last = spans.last, last.column + last.width == column, last.colour == background {
                    spans[spans.count - 1] = Span(column: last.column, width: last.width + width, colour: background)
                } else { spans.append(Span(column: column, width: width, colour: background)) }
            }
            let decorations = flags.intersection([.underline, .strike, .overline])
            if !decorations.isEmpty { rules.append(Rule(column: column, width: width, colour: foreground, kind: decorations)) }
            let visible = !flags.contains(.invisible) && cell.scalar > 0x20
            let scalar = visible ? Unicode.Scalar(cell.scalar) ?? " " : " "
            // ASCII (and blanks) share one line per style; anything else is placed on its own
            // cell, so a fallback font's advance can't push later characters off the grid.
            let simple = scalar.value < 0x7F && width == 1 && line.marks[column] == nil
            if !simple || runStyle != style { flush() }
            if runText.isEmpty { runStart = column; runStyle = style }
            runText.append(scalar)
            if let mark = line.marks[column] { runText.append(contentsOf: mark.unicodeScalars) }
            if !simple { flush() }
            column += width
        }
        flush()
        self.spans = spans
        self.runs = runs
        self.rules = rules
    }

    func draw(in context: CGContext, y: CGFloat, fonts: TerminalFonts, inset: CGFloat) {
        let width = fonts.cellWidth
        for span in spans {
            context.setFillColor(span.colour)
            context.fill(CGRect(x: inset + CGFloat(span.column) * width, y: y, width: CGFloat(span.width) * width, height: fonts.lineHeight))
        }
        let baseline = y + floor((fonts.lineHeight - (CTFontGetAscent(fonts.regular) + CTFontGetDescent(fonts.regular))) / 2) + fonts.ascent
        for run in runs {
            context.textPosition = CGPoint(x: inset + CGFloat(run.column) * width, y: baseline)
            CTLineDraw(run.line, context)
        }
        for rule in rules {
            context.setFillColor(rule.colour)
            let x = inset + CGFloat(rule.column) * width
            let length = CGFloat(rule.width) * width
            if rule.kind.contains(.underline) { context.fill(CGRect(x: x, y: baseline + 2, width: length, height: 1)) }
            if rule.kind.contains(.strike) { context.fill(CGRect(x: x, y: baseline - fonts.ascent * 0.32, width: length, height: 1)) }
            if rule.kind.contains(.overline) { context.fill(CGRect(x: x, y: y + 1, width: length, height: 1)) }
        }
    }
}
