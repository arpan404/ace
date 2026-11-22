import SwiftUI
import UIKit

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
        let action = UIColor(AceDesign.Ink.action)
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
            // A code note starts here: a dot in the action colour by its number's left edge.
            if host.notes[line] != nil {
                let dot = AceTheme.Spacing.sm - AceDesign.Size.rail
                action.setFill()
                UIBezierPath(ovalIn: CGRect(x: AceTheme.Spacing.xs, y: y + (firstLine - dot) / 2, width: dot, height: dot)).fill()
            }
            switch host.marks[line] {
            case "added", "modified":
                UIColor(AceTheme.StatusText.done).setFill()
                UIRectFill(CGRect(x: width - FileDiffStyle.bar, y: y, width: FileDiffStyle.bar, height: frame.height))
            case "removed":
                UIColor(AceTheme.StatusText.failed).setFill()
                UIRectFill(CGRect(x: 0, y: y, width: width, height: AceDesign.Size.rail))
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
