import SwiftUI
import UIKit

/// What a file screen hands its source view: the text with the web's grammar colours (runs over
/// UTF-16 units, colour N is `colours[N - 1]`) and the lines changed since the last commit.
struct SourceDocument: Equatable {
    /// Changes when a different text loads (another file, version or an edit session).
    let key: String
    let text: String
    let colours: [[String]]
    let runs: [Int]
    let marks: [Int: String]
}

/// Lets toolbar buttons reach the text view: its find navigator and the text being edited.
@MainActor final class SourceHandle {
    weak var view: UITextView?
    func find() { view?.findInteraction?.presentFindNavigator(showingReplace: view?.isEditable == true) }
    var text: String { view?.text ?? "" }
}

/// Source in SF Mono with line numbers in a gutter that stays put while lines scroll sideways,
/// change bars beside them as the web's viewer draws, the system find navigator, and wrapping on
/// request (editing always wraps, so the caret stays on screen). TextKit 2 lays out only what is
/// near the screen, so a 2 MB file opens like a short one.
struct SourceTextView: UIViewRepresentable {
    let document: SourceDocument
    let wrap: Bool
    let editable: Bool
    /// A line (1-based) to bring into view once, highlighted.
    let line: Int?
    let handle: SourceHandle
    /// Called once the edited text first differs from what was loaded, and again if it returns.
    var dirty: ((Bool) -> Void)?

    func makeUIView(context: Context) -> SourceContainer {
        let view = SourceContainer()
        view.text.delegate = context.coordinator
        handle.view = view.text
        return view
    }

    func updateUIView(_ view: SourceContainer, context: Context) {
        context.coordinator.parent = self
        handle.view = view.text
        view.text.isEditable = editable
        if context.coordinator.key != document.key {
            context.coordinator.key = document.key
            context.coordinator.original = document.text
            context.coordinator.wasDirty = false
            view.load(document)
            if let line { view.reveal(line: line) }
        }
        view.wrap = wrap || editable
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    @MainActor final class Coordinator: NSObject, UITextViewDelegate {
        var parent: SourceTextView
        var key = ""
        var original = ""
        var wasDirty = false
        init(parent: SourceTextView) { self.parent = parent }
        func textViewDidChange(_ textView: UITextView) {
            (textView.superview?.superview as? SourceContainer)?.textChanged()
            let now = textView.text != original
            if now != wasDirty { wasDirty = now; parent.dirty?(now) }
        }
        func scrollViewDidScroll(_ scrollView: UIScrollView) {
            (scrollView.superview?.superview as? SourceContainer)?.gutter.setNeedsDisplay()
        }
    }
}

/// The text view (scrolling up and down, as wide as the longest line) inside a sideways scroller,
/// with the gutter laid over the left edge so numbers stay put while lines scroll under them.
final class SourceContainer: UIView {
    let text = UITextView(usingTextLayoutManager: true)
    let gutter = SourceGutter()
    private let sideways = UIScrollView()
    private let highlight = UIView()
    /// Where each line starts, in UTF-16 units, for the gutter's numbers.
    private(set) var lineStarts: [Int] = [0]
    private var longest = 0
    var marks: [Int: String] = [:]
    var targetLine: Int?
    var wrap = false {
        didSet { if wrap != oldValue { setNeedsLayout() } }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        sideways.showsVerticalScrollIndicator = false
        sideways.alwaysBounceHorizontal = false
        sideways.contentInsetAdjustmentBehavior = .never
        addSubview(sideways)
        sideways.addSubview(text)
        text.accessibilityIdentifier = "preview.text"
        text.isEditable = false
        text.isFindInteractionEnabled = true
        text.alwaysBounceVertical = true
        text.autocorrectionType = .no
        text.autocapitalizationType = .none
        text.smartQuotesType = .no
        text.smartDashesType = .no
        text.smartInsertDeleteType = .no
        text.spellCheckingType = .no
        text.keyboardDismissMode = .interactive
        text.textContainer.lineFragmentPadding = 0
        highlight.isHidden = true
        highlight.isUserInteractionEnabled = false
        text.insertSubview(highlight, at: 0)
        gutter.host = self
        gutter.isUserInteractionEnabled = false
        addSubview(gutter)
        refreshColours()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: SourceContainer, _: UITraitCollection) in view.refreshColours() }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    var font: UIFont {
        UIFont.monospacedSystemFont(ofSize: UIFontMetrics(forTextStyle: .footnote).scaledValue(for: AceTheme.Typography.code.size, compatibleWith: traitCollection), weight: .regular)
    }
    private var lineHeight: CGFloat { UIFontMetrics(forTextStyle: .footnote).scaledValue(for: AceTheme.Typography.code.lineHeight, compatibleWith: traitCollection) }
    private var charWidth: CGFloat { ("M" as NSString).size(withAttributes: [.font: font]).width }
    var gutterWidth: CGFloat { max(40, CGFloat(String(lineStarts.count).count) * charWidth + AceTheme.Spacing.xl) }

    private func attributes() -> [NSAttributedString.Key: Any] {
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = lineHeight
        paragraph.maximumLineHeight = lineHeight
        paragraph.lineBreakMode = .byCharWrapping
        paragraph.defaultTabInterval = charWidth * 4
        paragraph.tabStops = []
        return [.font: font, .foregroundColor: UIColor(AceTheme.Colours.foreground), .paragraphStyle: paragraph]
    }

    func load(_ document: SourceDocument) {
        let base = attributes()
        let attributed = NSMutableAttributedString(string: document.text, attributes: base)
        let length = attributed.length
        let palette = document.colours.map { pair in
            let light = UIColor(hex: pair.first ?? ""), dark = UIColor(hex: pair.last ?? "")
            return UIColor { $0.userInterfaceStyle == .dark ? dark : light }
        }
        var at = 0
        attributed.beginEditing()
        for index in stride(from: 0, to: document.runs.count - 1, by: 2) {
            let run = document.runs[index], colour = document.runs[index + 1]
            if at + run > length { break }
            if colour > 0, colour <= palette.count {
                attributed.addAttribute(.foregroundColor, value: palette[colour - 1], range: NSRange(location: at, length: run))
            }
            at += run
        }
        attributed.endEditing()
        text.typingAttributes = base
        text.attributedText = attributed
        marks = document.marks
        countLines()
        highlight.isHidden = true
        targetLine = nil
        setNeedsLayout()
        layoutIfNeeded()
        sideways.contentOffset = .zero
        text.setContentOffset(CGPoint(x: 0, y: -text.adjustedContentInset.top), animated: false)
    }

    /// Line starts and the widest line (wide characters count twice), in one pass.
    private func countLines() {
        var starts = [0]
        var widest = 0, column = 0, offset = 0
        for unit in text.text.utf16 {
            offset += 1
            if unit == 10 {
                starts.append(offset)
                widest = max(widest, column)
                column = 0
            } else {
                column += unit == 9 ? 4 : (unit < 0x1100 ? 1 : 2)
            }
        }
        lineStarts = starts
        longest = max(widest, column)
    }

    /// After typing: numbers and widths follow the new text.
    func textChanged() {
        let lines = lineStarts.count
        countLines()
        if lines != lineStarts.count { setNeedsLayout() }
        gutter.setNeedsDisplay()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        sideways.frame = bounds
        let left = gutterWidth + AceTheme.Spacing.md
        text.textContainerInset = UIEdgeInsets(top: AceTheme.Spacing.sm, left: left, bottom: AceTheme.Spacing.xxxl, right: AceTheme.Spacing.xl)
        // Lines never wrap unless asked: the text is as wide as its longest line, bounded so one
        // minified line can't make a layout too wide to draw (past that it wraps).
        let columns = CGFloat(min(longest, 1000) + 2)
        let width = wrap ? bounds.width : max(bounds.width, left + columns * charWidth + AceTheme.Spacing.xl)
        if text.frame.size != CGSize(width: width, height: bounds.height) {
            text.frame = CGRect(x: 0, y: 0, width: width, height: bounds.height)
        }
        sideways.contentSize = CGSize(width: width, height: bounds.height)
        gutter.frame = CGRect(x: 0, y: 0, width: gutterWidth, height: bounds.height)
        gutter.setNeedsDisplay()
        if let line = pendingLine, bounds.height > 0 {
            DispatchQueue.main.async { [weak self] in self?.reveal(line: line) }
        }
    }

    /// The 0-based line holding UTF-16 offset `offset`.
    func lineIndex(at offset: Int) -> Int {
        var low = 0, high = lineStarts.count - 1
        while low < high {
            let middle = (low + high + 1) / 2
            if lineStarts[middle] <= offset { low = middle } else { high = middle - 1 }
        }
        return low
    }

    /// A line to reveal once the view has its size.
    private var pendingLine: Int?

    /// Scroll `line` (1-based) to the middle of the screen and tint it.
    func reveal(line: Int) {
        guard bounds.height > 0 else { pendingLine = line; setNeedsLayout(); return }
        pendingLine = nil
        guard line > 0, line <= lineStarts.count, let layout = text.textLayoutManager, let content = layout.textContentManager,
              let location = content.location(content.documentRange.location, offsetBy: lineStarts[line - 1]) else { return }
        targetLine = line
        layout.ensureLayout(for: NSTextRange(location: content.documentRange.location, end: location) ?? NSTextRange(location: location))
        layout.enumerateTextLayoutFragments(from: location, options: [.ensuresLayout]) { fragment in
            let frame = fragment.layoutFragmentFrame.offsetBy(dx: 0, dy: self.text.textContainerInset.top)
            self.highlight.frame = CGRect(x: 0, y: frame.minY, width: self.text.bounds.width, height: frame.height)
            self.highlight.isHidden = false
            let inset = self.text.adjustedContentInset
            let maxY = max(-inset.top, self.text.contentSize.height - self.text.bounds.height + inset.bottom)
            let y = min(max(-inset.top, frame.midY - self.text.bounds.height / 2), maxY)
            self.text.setContentOffset(CGPoint(x: 0, y: y), animated: false)
            return false
        }
        gutter.setNeedsDisplay()
    }

    private func refreshColours() {
        backgroundColor = UIColor(AceTheme.Colours.background)
        text.backgroundColor = UIColor(AceTheme.Colours.background)
        highlight.backgroundColor = UIColor(AceTheme.Colours.foreground).withAlphaComponent(0.07)
        gutter.setNeedsDisplay()
    }
}

/// The line numbers and change bars, drawn for the lines on screen only.
final class SourceGutter: UIView {
    weak var host: SourceContainer?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = true
        contentMode = .redraw
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func draw(_ rect: CGRect) {
        UIColor(AceTheme.Colours.background).setFill()
        UIRectFill(bounds)
        guard let host, let layout = host.text.textLayoutManager, let content = layout.textContentManager else { return }
        let text = host.text
        let inset = text.textContainerInset.top
        // Container coordinates of the gutter's top and bottom edges.
        let top = text.contentOffset.y - inset
        let bottom = top + bounds.height
        let size = host.font.pointSize - 1
        let numberFont = UIFont.monospacedDigitSystemFont(ofSize: size, weight: .regular)
        let strongFont = UIFont.monospacedDigitSystemFont(ofSize: size, weight: .semibold)
        let start = layout.textLayoutFragment(for: CGPoint(x: 0, y: max(0, top)))?.rangeInElement.location ?? layout.documentRange.location
        let width = bounds.width
        let muted = UIColor(AceTheme.Colours.subtleForeground), ink = UIColor(AceTheme.Colours.foreground)
        layout.enumerateTextLayoutFragments(from: start, options: [.ensuresLayout]) { fragment in
            let frame = fragment.layoutFragmentFrame
            if frame.minY > bottom { return false }
            let line = host.lineIndex(at: content.offset(from: content.documentRange.location, to: fragment.rangeInElement.location)) + 1
            let y = frame.minY - top
            let firstLine = fragment.textLineFragments.first?.typographicBounds.height ?? frame.height
            let target = host.targetLine == line
            let label = String(line) as NSString
            let attributes: [NSAttributedString.Key: Any] = [.font: target ? strongFont : numberFont, .foregroundColor: target ? ink : muted]
            let measured = label.size(withAttributes: attributes)
            label.draw(at: CGPoint(x: width - AceTheme.Spacing.md - measured.width, y: y + (firstLine - measured.height) / 2), withAttributes: attributes)
            switch host.marks[line] {
            case "added", "modified":
                UIColor(AceTheme.StatusText.done).setFill()
                UIRectFill(CGRect(x: width - 3, y: y, width: 3, height: frame.height))
            case "removed":
                UIColor(AceTheme.StatusText.failed).setFill()
                UIRectFill(CGRect(x: 0, y: y, width: width, height: 2))
            default: break
            }
            return true
        }
    }
}

extension UIColor {
    /// "#rrggbb"; black when it doesn't parse.
    convenience init(hex: String) {
        let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        let value = UInt32(digits, radix: 16) ?? 0
        self.init(red: CGFloat((value >> 16) & 255) / 255, green: CGFloat((value >> 8) & 255) / 255, blue: CGFloat(value & 255) / 255, alpha: 1)
    }
}
