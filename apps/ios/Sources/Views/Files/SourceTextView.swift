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
/// request. TextKit 2 lays out only what is near the screen, so a 2 MB file opens like a short one.
struct SourceTextView: UIViewRepresentable {
    let document: SourceDocument
    let wrap: Bool
    let editable: Bool
    /// A line (1-based) to bring into view once, highlighted.
    let line: Int?
    let handle: SourceHandle
    /// Called once the edited text first differs from what was loaded, and again if it returns.
    var dirty: ((Bool) -> Void)?

    func makeUIView(context: Context) -> CodeTextView {
        let view = CodeTextView(usingTextLayoutManager: true)
        view.delegate = context.coordinator
        view.accessibilityIdentifier = "preview.text"
        handle.view = view
        return view
    }

    func updateUIView(_ view: CodeTextView, context: Context) {
        context.coordinator.parent = self
        handle.view = view
        view.isEditable = editable
        if context.coordinator.key != document.key {
            context.coordinator.key = document.key
            context.coordinator.original = document.text
            view.load(document, wrap: wrap)
            if let line { DispatchQueue.main.async { view.reveal(line: line) } }
        } else if view.wrap != wrap {
            view.setWrap(wrap)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    @MainActor final class Coordinator: NSObject, UITextViewDelegate {
        var parent: SourceTextView
        var key = ""
        var original = ""
        private var wasDirty = false
        init(parent: SourceTextView) { self.parent = parent }
        func textViewDidChange(_ textView: UITextView) {
            (textView as? CodeTextView)?.textChanged()
            let now = textView.text != original
            if now != wasDirty { wasDirty = now; parent.dirty?(now) }
        }
    }
}

/// The text view behind `SourceTextView`.
final class CodeTextView: UITextView {
    private let gutter = SourceGutter()
    private let highlight = UIView()
    private(set) var wrap = false
    /// Where each line starts, in UTF-16 units, for the gutter's numbers.
    private(set) var lineStarts: [Int] = [0]
    private var longest = 0
    var marks: [Int: String] = [:]
    var targetLine: Int?

    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        configure()
    }
    required init?(coder: NSCoder) {
        super.init(coder: coder)
        configure()
    }
    private func configure() {
        backgroundColor = UIColor(AceTheme.Colours.background)
        isEditable = false
        isFindInteractionEnabled = true
        alwaysBounceVertical = true
        autocorrectionType = .no
        autocapitalizationType = .none
        smartQuotesType = .no
        smartDashesType = .no
        smartInsertDeleteType = .no
        spellCheckingType = .no
        keyboardDismissMode = .interactive
        textContainer.lineFragmentPadding = 0
        gutter.host = self
        gutter.isUserInteractionEnabled = false
        highlight.backgroundColor = UIColor(AceTheme.Colours.foreground).withAlphaComponent(0.06)
        highlight.isHidden = true
        highlight.isUserInteractionEnabled = false
        addSubview(highlight)
        addSubview(gutter)
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: CodeTextView, _: UITraitCollection) in view.refreshColours() }
    }

    var font13: UIFont {
        UIFont.monospacedSystemFont(ofSize: UIFontMetrics(forTextStyle: .footnote).scaledValue(for: AceTheme.Typography.code.size, compatibleWith: traitCollection), weight: .regular)
    }
    private var lineHeight: CGFloat { UIFontMetrics(forTextStyle: .footnote).scaledValue(for: AceTheme.Typography.code.lineHeight, compatibleWith: traitCollection) }
    var charWidth: CGFloat { ("M" as NSString).size(withAttributes: [.font: font13]).width }
    var gutterWidth: CGFloat { max(40, CGFloat(String(lineStarts.count).count) * charWidth + AceTheme.Spacing.xl) }

    private func attributes() -> [NSAttributedString.Key: Any] {
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = lineHeight
        paragraph.maximumLineHeight = lineHeight
        paragraph.lineBreakMode = .byCharWrapping
        paragraph.defaultTabInterval = charWidth * 4
        paragraph.tabStops = []
        return [.font: font13, .foregroundColor: UIColor(AceTheme.Colours.foreground), .paragraphStyle: paragraph]
    }

    func load(_ document: SourceDocument, wrap: Bool) {
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
        typingAttributes = base
        attributedText = attributed
        marks = document.marks
        countLines()
        self.wrap = wrap
        applyWrap()
        highlight.isHidden = true
        targetLine = nil
        setContentOffset(CGPoint(x: -adjustedContentInset.left, y: -adjustedContentInset.top), animated: false)
    }

    func setWrap(_ value: Bool) {
        wrap = value
        applyWrap()
    }

    private func applyWrap() {
        textContainerInset = UIEdgeInsets(top: AceTheme.Spacing.sm, left: gutterWidth + AceTheme.Spacing.md, bottom: AceTheme.Spacing.xxxl, right: AceTheme.Spacing.xl)
        if wrap {
            textContainer.widthTracksTextView = true
        } else {
            textContainer.widthTracksTextView = false
            // Lines never wrap: the container is as wide as the longest line (bounded, so one
            // minified line can't make a layout millions of points wide).
            let columns = CGFloat(min(longest, 20_000) + 4)
            textContainer.size = CGSize(width: columns * charWidth, height: .greatestFiniteMagnitude)
        }
        setNeedsLayout()
        gutter.setNeedsDisplay()
    }

    /// Line starts and the widest line (wide characters count twice), in one pass.
    private func countLines() {
        var starts = [0]
        var widest = 0, column = 0, offset = 0
        for unit in text.utf16 {
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

    /// After typing: numbers and the editor's width follow the new text.
    func textChanged() {
        let lines = lineStarts.count
        countLines()
        if lines != lineStarts.count || !wrap { applyWrap() }
        gutter.setNeedsDisplay()
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

    /// Scroll `line` (1-based) to the middle of the screen and tint it.
    func reveal(line: Int) {
        guard line > 0, line <= lineStarts.count, let layout = textLayoutManager, let content = layout.textContentManager,
              let location = content.location(content.documentRange.location, offsetBy: lineStarts[line - 1]) else { return }
        targetLine = line
        layout.ensureLayout(for: NSTextRange(location: content.documentRange.location, end: location) ?? NSTextRange(location: location))
        layout.enumerateTextLayoutFragments(from: location, options: [.ensuresLayout]) { fragment in
            let frame = fragment.layoutFragmentFrame.offsetBy(dx: 0, dy: self.textContainerInset.top)
            self.highlight.frame = CGRect(x: 0, y: frame.minY, width: max(self.contentSize.width, self.bounds.width) + 4000, height: frame.height)
            self.highlight.isHidden = false
            let maxY = max(-self.adjustedContentInset.top, self.contentSize.height - self.bounds.height + self.adjustedContentInset.bottom)
            let y = min(max(-self.adjustedContentInset.top, frame.midY - self.bounds.height / 2), maxY)
            self.setContentOffset(CGPoint(x: -self.adjustedContentInset.left, y: y), animated: false)
            return false
        }
        gutter.setNeedsDisplay()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        gutter.frame = CGRect(x: contentOffset.x, y: contentOffset.y, width: gutterWidth, height: bounds.height)
        sendSubviewToBack(highlight)
        bringSubviewToFront(gutter)
        gutter.setNeedsDisplay()
    }

    private func refreshColours() {
        backgroundColor = UIColor(AceTheme.Colours.background)
        highlight.backgroundColor = UIColor(AceTheme.Colours.foreground).withAlphaComponent(0.06)
        gutter.setNeedsDisplay()
    }
}

/// The line numbers and change bars, drawn for the lines on screen only.
final class SourceGutter: UIView {
    weak var host: CodeTextView?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = true
        contentMode = .redraw
    }
    required init?(coder: NSCoder) { super.init(coder: coder) }

    override func draw(_ rect: CGRect) {
        guard let host, let layout = host.textLayoutManager, let content = layout.textContentManager else { return }
        UIColor(AceTheme.Colours.background).setFill()
        UIRectFill(bounds)
        let inset = host.textContainerInset.top
        let top = host.contentOffset.y - inset
        let bottom = top + bounds.height
        let numberFont = UIFont.monospacedDigitSystemFont(ofSize: host.font13.pointSize - 1, weight: .regular)
        let strongFont = UIFont.monospacedDigitSystemFont(ofSize: host.font13.pointSize - 1, weight: .semibold)
        let start = layout.textLayoutFragment(for: CGPoint(x: 0, y: max(0, top)))?.rangeInElement.location ?? layout.documentRange.location
        let width = bounds.width
        layout.enumerateTextLayoutFragments(from: start, options: [.ensuresLayout]) { fragment in
            let frame = fragment.layoutFragmentFrame
            if frame.minY > bottom { return false }
            let line = host.lineIndex(at: content.offset(from: content.documentRange.location, to: fragment.rangeInElement.location)) + 1
            let y = frame.minY - top
            let firstLine = fragment.textLineFragments.first?.typographicBounds.height ?? frame.height
            let target = host.targetLine == line
            let label = String(line) as NSString
            let attributes: [NSAttributedString.Key: Any] = [
                .font: target ? strongFont : numberFont,
                .foregroundColor: UIColor(target ? AceTheme.Colours.foreground : AceTheme.Colours.subtleForeground),
            ]
            let size = label.size(withAttributes: attributes)
            label.draw(at: CGPoint(x: width - AceTheme.Spacing.md - size.width, y: y + (firstLine - size.height) / 2), withAttributes: attributes)
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
