import SwiftUI
import UIKit

/// What a file screen hands its source view: the text, the language markit colours it in (nil
/// shows it plain) and the lines changed since the last commit.
struct SourceDocument: Equatable {
    /// Changes when a different text loads (another file, version or an edit session).
    let key: String
    let text: String
    let language: String?
    let marks: [Int: String]
    /// The file as saved, when `text` is a draft carried over from an earlier editor: changes are
    /// measured against it.
    var original: String? = nil
    /// Which file this is, when notes are kept on it: new text for the same file is followed from
    /// the text before it, another file's never is.
    var file: String? = nil
}

/// Lets toolbar buttons reach the text view: its find navigator, the text being edited and go to
/// line.
@MainActor final class SourceHandle {
    weak var view: UITextView?
    func find() { view?.findInteraction?.presentFindNavigator(showingReplace: view?.isEditable == true) }
    var text: String { view?.text ?? "" }
    private var container: SourceContainer? { view?.superview?.superview as? SourceContainer }
    /// Lines in the text as it is now, edits included.
    var lineCount: Int { container?.lineStarts.count ?? 1 }
    /// A 1-based line's length in UTF-16 units, without its line break.
    func lineLength(_ line: Int) -> Int { container?.lineLength(line) ?? 0 }
    func go(to target: GoToLine.Target) { container?.go(line: target.line, column: target.column) }
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
    /// The lines (1-based) the person selected while reading, nil once nothing is; with `mention`,
    /// the selection's edit menu also offers Mention in message.
    var selected: ((ClosedRange<Int>?) -> Void)? = nil
    var mention: ((ClosedRange<Int>) -> Void)? = nil
    /// The view is going while editable, with this text in it (a tab moved, or its group hid).
    var left: ((String) -> Void)? = nil
    /// The person tapped the text or began typing in it.
    var touched: (() -> Void)? = nil
    /// Annotate (editing) or Comment (reading) on a selection: its range, for a note on it.
    var annotate: ((TextSpan) -> Void)? = nil
    /// The 1-based lines a note starts on, with its number: a marker in the gutter.
    var notes: [Int: Int] = [:]
    /// The person typed: what the edit replaced, and the text's lines (0-based) after it.
    var edited: ((TextReplacement, (Int) -> String) -> Void)? = nil
    /// Other text loaded over what the view showed (nil the first time), and the new text's lines.
    var loaded: (@MainActor ([String]?, [String]) -> Void)? = nil

    func makeUIView(context: Context) -> SourceContainer {
        let view = SourceContainer()
        view.text.delegate = context.coordinator
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tapped))
        tap.cancelsTouchesInView = false
        tap.delegate = context.coordinator
        view.addGestureRecognizer(tap)
        handle.view = view.text
        return view
    }

    static func dismantleUIView(_ view: SourceContainer, coordinator: Coordinator) {
        if view.text.isEditable { coordinator.parent.left?(view.text.text) }
    }

    func updateUIView(_ view: SourceContainer, context: Context) {
        context.coordinator.parent = self
        handle.view = view.text
        view.text.isEditable = editable
        if view.notes != notes { view.notes = notes; view.gutter.setNeedsDisplay() }
        if context.coordinator.key != document.key {
            let same = !context.coordinator.key.isEmpty && document.file != nil && context.coordinator.file == document.file
            let earlier = same ? view.text.text : nil
            context.coordinator.file = document.file
            if let loaded, !notes.isEmpty { Self.tell(loaded, earlier: earlier, now: document.text) }
            context.coordinator.key = document.key
            context.coordinator.original = document.original ?? document.text
            context.coordinator.wasDirty = document.original.map { $0 != document.text } ?? false
            view.load(document)
            if let line { view.reveal(line: line) }
        }
        view.wrap = wrap || editable
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    @MainActor final class Coordinator: NSObject, UITextViewDelegate, UIGestureRecognizerDelegate {
        var parent: SourceTextView
        var key = ""
        /// The file the loaded text is (`SourceDocument.file`).
        var file: String?
        var original = ""
        var wasDirty = false
        init(parent: SourceTextView) { self.parent = parent }
        /// What the edit in progress replaces, measured before it lands (`textViewDidChange`).
        var pending: TextReplacement?
        func textViewDidChange(_ textView: UITextView) {
            let container = textView.superview?.superview as? SourceContainer
            container?.textChanged()
            if let pending, let container, let edited = parent.edited { edited(pending) { container.lineText($0) } }
            pending = nil
            let now = textView.text != original
            if now != wasDirty { wasDirty = now; parent.dirty?(now) }
        }
        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            if parent.edited != nil, let container = textView.superview?.superview as? SourceContainer {
                pending = container.replacement(range, with: text)
            }
            return true
        }
        @objc func tapped() { parent.touched?() }
        func textViewDidBeginEditing(_ textView: UITextView) { parent.touched?() }
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
        func textViewDidChangeSelection(_ textView: UITextView) {
            guard let selected = parent.selected else { return }
            selected(lines(textView))
        }
        func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
            var actions: [UIMenuElement] = []
            if let annotate = parent.annotate, let span = span(textView) {
                actions.append(UIAction(title: textView.isEditable ? "Annotate" : "Comment", image: UIImage(ace: .notePencil)) { _ in annotate(span) })
            }
            if let mention = parent.mention, !textView.isEditable, let lines = lines(textView) {
                actions.append(UIAction(title: "Mention in message", image: UIImage(ace: .at)) { _ in mention(lines) })
            }
            return actions.isEmpty ? nil : UIMenu(children: actions + suggestedActions)
        }
        /// The 1-based lines a non-empty selection touches while reading.
        private func lines(_ textView: UITextView) -> ClosedRange<Int>? {
            let range = textView.selectedRange
            guard range.length > 0, !textView.isEditable,
                  let container = textView.superview?.superview as? SourceContainer else { return nil }
            let first = container.line(at: range.location)
            // A selection ending just after a line break stays on the line before it.
            let last = container.line(at: max(range.location, range.location + range.length - 1))
            return first...max(first, last)
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
    /// The text's UTF-16 length; a go-to line to bring back once the keyboard resizes the view.
    private var length = 0, revealOnResize: Int?, lastHeight: CGFloat = 0
    var marks: [Int: String] = [:]
    /// The 1-based lines a code note starts on, with its number.
    var notes: [Int: Int] = [:]
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
    /// The 1-based line holding UTF-16 offset `offset`.
    func line(at offset: Int) -> Int { lineIndex(at: offset) + 1 }
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

    /// Colours being read for the text on screen, off the main thread.
    private var colouring: Task<Void, Never>?

    func load(_ document: SourceDocument) {
        let base = attributes()
        colouring?.cancel()
        colouring = nil
        text.typingAttributes = base
        // The text shows plain at once; its colours land over the same glyphs when read.
        text.attributedText = NSAttributedString(string: document.text, attributes: base)
        if let language = document.language, !language.isEmpty, !document.text.isEmpty,
           document.text.utf16.count <= SourceColours.limit {
            // Cancelled by the next load: a file opened after it never waits on its colours.
            colouring = Task { [weak self, theme = AceMarkdownTheme.current()] in
                let colours = await SourceColours.read(document.text, language: language, theme: theme)
                // Only over the text it was read for: not another file, nor one being edited since.
                guard let self, !Task.isCancelled, let colours, self.text.text == document.text else { return }
                let storage = self.text.textStorage
                await colours.apply(to: storage) { [weak self] in self?.text.isEditable == false || self?.text.text == document.text }
            }
        }
        marks = document.marks
        countLines()
        highlight.isHidden = true
        targetLine = nil
        revealOnResize = nil
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
        length = offset
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
        } else if let line = revealOnResize, bounds.height != lastHeight {
            revealOnResize = nil
            DispatchQueue.main.async { [weak self] in self?.reveal(line: line); self?.revealCaret() }
        }
        lastHeight = bounds.height
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

    /// A 1-based line's length in UTF-16 units, without its line break.
    func lineLength(_ line: Int) -> Int {
        guard line > 0, line <= lineStarts.count else { return 0 }
        let end = line < lineStarts.count ? lineStarts[line] - 1 : length
        return max(0, end - lineStarts[line - 1])
    }

    /// Go to line: the caret lands on `line` at `column` (both 1-based, clamped to the text) and
    /// the line scrolls into view, tinted. While editing the keyboard comes up, and the line is
    /// brought back into view once it has made the view shorter.
    func go(line: Int, column: Int) {
        let line = min(max(1, line), lineStarts.count)
        let offset = lineStarts[line - 1] + min(max(0, column - 1), lineLength(line))
        text.selectedRange = NSRange(location: offset, length: 0)
        if text.isEditable, !text.isFirstResponder {
            revealOnResize = line
            text.becomeFirstResponder()
        }
        reveal(line: line)
        revealCaret()
    }

    /// After go to line: a column off screen (further down a wrapped line, or past the right edge)
    /// scrolls into view too, clear of the gutter laid over the left edge.
    private func revealCaret() {
        guard let position = text.selectedTextRange?.end else { return }
        let caret = text.caretRect(for: position)
        guard !caret.isNull, !caret.isInfinite else { return }
        let seen = text.bounds
        if caret.minY < seen.minY || caret.maxY > seen.maxY {
            let inset = text.adjustedContentInset
            let maxY = max(-inset.top, text.contentSize.height - text.bounds.height + inset.bottom)
            text.setContentOffset(CGPoint(x: 0, y: min(max(-inset.top, caret.midY - seen.height / 2), maxY)), animated: false)
        }
        // The text is as wide as its longest line inside the sideways scroller, at x 0.
        let left = gutterWidth + AceTheme.Spacing.md
        let from = sideways.contentOffset.x
        if caret.minX < from + left || caret.maxX > from + sideways.bounds.width - AceTheme.Spacing.xl {
            let maxX = max(0, sideways.contentSize.width - sideways.bounds.width)
            let x = caret.minX - left - (sideways.bounds.width - left) / 2
            sideways.setContentOffset(CGPoint(x: min(max(0, x), maxX), y: 0), animated: false)
        }
        gutter.setNeedsDisplay()
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
        highlight.backgroundColor = UIColor(AceDesign.Surface.lineHighlight)
        gutter.setNeedsDisplay()
    }
}
