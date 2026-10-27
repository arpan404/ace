import UIKit

/// A found piece of text: the row it is on (by id, so it survives scrolling) and its columns.
struct TerminalMatch: Equatable, Sendable {
    let lineId: UInt64
    let column: Int
    let length: Int
}

/// The terminal surface: a scroll view over history and screen whose one drawing view stays in
/// the visible rect and draws only the rows showing. Rows are cached by id, so scrolling and
/// new output rebuild only the rows that changed.
final class TerminalCanvasView: UIScrollView, UIScrollViewDelegate {
    var session: TerminalSession? {
        didSet {
            guard session !== oldValue else { return }
            cache = [:]
            session?.onChange = { [weak self] in self?.contentChanged() }
            following = true
            contentChanged()
        }
    }
    /// The new grid size when the view's size or text size changes.
    var onFit: ((Int, Int) -> Void)?
    /// A tap on the surface (focus the keyboard).
    var onTap: (() -> Void)?
    /// Arrow keys (or mouse wheel bytes) from scrolling a full-screen program.
    var onScrollKeys: ((_ up: Bool, _ count: Int) -> Void)?
    var keyboardFocused = false { didSet { if keyboardFocused != oldValue { drawing.setNeedsDisplay() } } }
    var matches: [TerminalMatch] = [] { didSet { drawing.setNeedsDisplay() } }
    var currentMatch: TerminalMatch? { didSet { drawing.setNeedsDisplay() } }
    var fontSize: CGFloat = 12 {
        didSet {
            guard fontSize != oldValue else { return }
            fonts = TerminalFonts(size: fontSize)
            cache = [:]
            setNeedsLayout()
        }
    }

    private let drawing = DrawingView()
    private(set) var fonts = TerminalFonts(size: 12)
    private var cache: [UInt64: TerminalRowDrawing] = [:]
    private var palette: TerminalPalette?
    private var following = true
    private var grid = (columns: 0, rows: 0)
    private var totalRows = 0
    private var alternatePan: CGFloat = 0
    let inset: CGFloat = 8

    override init(frame: CGRect) {
        super.init(frame: frame)
        delegate = self
        alwaysBounceVertical = true
        showsHorizontalScrollIndicator = false
        indicatorStyle = .default
        keyboardDismissMode = .none
        contentInsetAdjustmentBehavior = .never
        drawing.owner = self
        drawing.isOpaque = true
        drawing.contentMode = .redraw
        addSubview(drawing)
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
        let pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
        pan.delegate = self
        addGestureRecognizer(pan)
        isAccessibilityElement = true
        accessibilityTraits = [.staticText, .allowsDirectInteraction]
        accessibilityIdentifier = "terminal.output"
    }
    required init?(coder: NSCoder) { nil }

    override func traitCollectionDidChange(_ previous: UITraitCollection?) {
        super.traitCollectionDidChange(previous)
        palette = nil
        cache = [:]
        drawing.setNeedsDisplay()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let columns = max(2, Int((bounds.width - inset * 2) / fonts.cellWidth))
        let rows = max(1, Int((bounds.height - inset) / fonts.lineHeight))
        if bounds.width > 0, bounds.height > 0, columns != grid.columns || rows != grid.rows {
            grid = (columns, rows)
            onFit?(columns, rows)
        }
        drawing.frame = CGRect(x: 0, y: contentOffset.y, width: bounds.width, height: bounds.height)
        drawing.setNeedsDisplay()
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        following = contentOffset.y >= maxOffset - fonts.lineHeight / 2
    }

    private var maxOffset: CGFloat { max(0, contentSize.height - bounds.height) }

    /// New output or a new size: grow the content and keep the newest row in view if it was.
    private func contentChanged() {
        guard let session else { return }
        let (history, rows) = session.read { ($0.historyCount, $0.rows) }
        totalRows = history + rows
        let height = CGFloat(totalRows) * fonts.lineHeight + inset
        if contentSize.height != height { contentSize = CGSize(width: bounds.width, height: height) }
        if following, contentOffset.y != maxOffset { contentOffset.y = maxOffset }
        accessibilityValue = nil
        drawing.setNeedsDisplay()
    }

    /// Bring a found match into view, centred.
    func reveal(_ match: TerminalMatch) {
        guard let session else { return }
        let index = session.read { screen -> Int? in
            let count = screen.historyCount + screen.rows
            for row in stride(from: count - 1, through: 0, by: -1) where screen.line(row).id == match.lineId { return row }
            return nil
        }
        guard let index else { return }
        let target = CGFloat(index) * fonts.lineHeight - bounds.height / 2
        setContentOffset(CGPoint(x: 0, y: max(0, min(maxOffset, target))), animated: !UIAccessibility.isReduceMotionEnabled)
    }

    func scrollToBottom() {
        following = true
        setContentOffset(CGPoint(x: 0, y: maxOffset), animated: !UIAccessibility.isReduceMotionEnabled)
    }

    override var accessibilityValue: String? {
        get { session?.read { screen in (0..<screen.rows).map { screen.lines[$0].text }.joined(separator: "\n") } }
        set {}
    }

    @objc private func tapped() { onTap?() }

    /// In a full-screen program there is nothing to scroll: a drag sends arrow keys instead,
    /// one per row dragged, as xterm's alternate scroll mode does.
    @objc private func panned(_ pan: UIPanGestureRecognizer) {
        guard session?.read({ $0.usingAlternate && $0.modes.alternateScroll }) == true else { return }
        if pan.state == .began { alternatePan = 0 }
        alternatePan += pan.translation(in: self).y
        pan.setTranslation(.zero, in: self)
        let rows = Int(alternatePan / fonts.lineHeight)
        if rows != 0 {
            alternatePan -= CGFloat(rows) * fonts.lineHeight
            onScrollKeys?(rows > 0, abs(rows))
        }
    }

    // MARK: Drawing

    fileprivate func draw(in context: CGContext, rect: CGRect) {
        guard let session else { return }
        let palette = self.palette ?? makePalette()
        self.palette = palette
        context.setFillColor(palette.background)
        context.fill(rect)
        let offset = contentOffset.y
        let first = max(0, Int(floor(offset / fonts.lineHeight)))
        let visible = Int(ceil(bounds.height / fonts.lineHeight)) + 1
        let shift = CGFloat(first) * fonts.lineHeight - offset
        let state = session.read { screen -> (lines: [TerminalLine], history: Int, row: Int, column: Int, cursor: Bool, shape: TerminalCursorShape, reverse: Bool) in
            let total = screen.historyCount + screen.rows
            let end = min(total, first + visible)
            let lines = first < end ? (first..<end).map { screen.line($0) } : []
            return (lines, screen.historyCount, screen.cursorRow, screen.cursorColumn, screen.modes.cursorVisible, screen.cursorShape, screen.modes.reverseVideo)
        }
        context.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
        var seen = Set<UInt64>()
        for (index, line) in state.lines.enumerated() {
            let y = shift + CGFloat(index) * fonts.lineHeight
            var row = cache[line.id]
            if row == nil || row?.cells != line.cells || row?.marks != line.marks {
                row = TerminalRowDrawing(line: line, palette: palette, fonts: fonts, reverse: state.reverse)
                cache[line.id] = row
            }
            seen.insert(line.id)
            highlight(line.id, y: y, in: context, palette: palette)
            row?.draw(in: context, y: y, fonts: fonts, inset: inset)
            if state.cursor, first + index == state.history + state.row {
                drawCursor(column: state.column, y: y, line: line, shape: state.shape, in: context, palette: palette)
            }
        }
        if cache.count > max(400, visible * 4) { cache = cache.filter { seen.contains($0.key) } }
    }

    private func highlight(_ id: UInt64, y: CGFloat, in context: CGContext, palette: TerminalPalette) {
        guard !matches.isEmpty else { return }
        for match in matches where match.lineId == id {
            context.setFillColor(match == currentMatch ? palette.currentMatch : palette.match)
            context.fill(CGRect(x: inset + CGFloat(match.column) * fonts.cellWidth, y: y,
                                width: CGFloat(match.length) * fonts.cellWidth, height: fonts.lineHeight))
        }
    }

    private func drawCursor(column: Int, y: CGFloat, line: TerminalLine, shape: TerminalCursorShape, in context: CGContext, palette: TerminalPalette) {
        let x = inset + CGFloat(column) * fonts.cellWidth
        let wide = column < line.cells.count && line.cells[column].style.flags.contains(.wide)
        let cell = CGRect(x: x, y: y, width: fonts.cellWidth * (wide ? 2 : 1), height: fonts.lineHeight)
        context.setFillColor(palette.cursor)
        context.setStrokeColor(palette.cursor)
        switch shape {
        case .bar: context.fill(CGRect(x: x, y: y, width: 2, height: fonts.lineHeight))
        case .underline: context.fill(CGRect(x: x, y: cell.maxY - 2, width: cell.width, height: 2))
        case .block:
            // Without the keyboard the cursor is an outline, so the character under it still reads.
            guard keyboardFocused else { context.stroke(cell.insetBy(dx: 0.5, dy: 0.5), width: 1); return }
            context.fill(cell)
            guard column < line.cells.count, let scalar = Unicode.Scalar(line.cells[column].scalar), scalar.value > 0x20 else { return }
            let attributes: [CFString: Any] = [kCTFontAttributeName: fonts.font(line.cells[column].style.flags), kCTForegroundColorAttributeName: palette.background]
            guard let text = CFAttributedStringCreate(nil, String(scalar) as CFString, attributes as CFDictionary) else { return }
            let baseline = y + floor((fonts.lineHeight - (CTFontGetAscent(fonts.regular) + CTFontGetDescent(fonts.regular))) / 2) + fonts.ascent
            context.textPosition = CGPoint(x: x, y: baseline)
            CTLineDraw(CTLineCreateWithAttributedString(text), context)
        }
    }

    private func makePalette() -> TerminalPalette {
        let traits = traitCollection
        return TerminalPalette(foreground: UIColor(AceTheme.Colours.foreground).resolvedColor(with: traits),
                               background: UIColor(AceTheme.Colours.background).resolvedColor(with: traits),
                               dark: traits.userInterfaceStyle == .dark)
    }

    fileprivate final class DrawingView: UIView {
        weak var owner: TerminalCanvasView?
        override func draw(_ rect: CGRect) {
            guard let context = UIGraphicsGetCurrentContext() else { return }
            owner?.draw(in: context, rect: rect)
        }
    }
}

extension TerminalCanvasView: UIGestureRecognizerDelegate {
    func gestureRecognizer(_ gesture: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
}
