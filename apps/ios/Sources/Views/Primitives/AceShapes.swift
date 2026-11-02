import SwiftUI

/// Every corner in the app, named for what it is and drawn from `AceDesign`: controls are capsules,
/// surfaces that grow with their text are capsules until they wrap, and containers nest
/// concentrically inside their parent and the display (DESIGN.md §2: inner radius = outer radius
/// − the inset between them). Views name a shape from here and never write a radius of their own.
@MainActor enum AceShape {
    /// Buttons, pills, chips, toasts, search and one-line fields, pressed fills on small text actions.
    static let capsule = AceDesign.Shape.control
    /// The composer's field and anything that grows with its text: a capsule while one line
    /// tall, then concentric with its container.
    static let field = AceDesign.Shape.field
    /// A container: the composer block, a strip, a grouped list, a sheet's surface.
    static var group: AnyShape { AceDesign.Shape.container }
    /// The person's message: a capsule for a short line, then concentric with the page.
    static let bubble = AceDesign.Shape.bubble
    /// Code inside the person's message: concentric with the bubble.
    static var bubbleInset: AnyShape { AceDesign.Shape.container }
    /// Code blocks, images, diffs on the page: concentric with the screen at the margin.
    static var block: AnyShape { AceDesign.Shape.block }
    /// A row's pressed or chosen fill: concentric with the list it sits in.
    static let rowRadius = AceDesign.Corner.containerFloor
    /// The tiny drawn glyphs (the Stop square, a file-status box): their corner scales with the
    /// glyph, part of its drawing rather than a UI radius.
    static let stopGlyph = RoundedRectangle(cornerRadius: AceDesign.Corner.glyphStop, style: .continuous)
    static let glyph = RoundedRectangle(cornerRadius: AceDesign.Corner.glyph, style: .continuous)

    /// The concentric radius inside `outer` at `inset` from its edge.
    nonisolated static func nested(in outer: CGFloat, inset: CGFloat) -> CGFloat {
        AceDesign.Corner.nested(in: outer, inset: inset)
    }
}

struct TextCapsule: InsettableShape {
    var maxRadius: CGFloat
    var inset: CGFloat = 0
    func radius(for size: CGSize) -> CGFloat { min(size.height / 2, maxRadius) }
    func path(in rect: CGRect) -> Path {
        let box = rect.insetBy(dx: inset, dy: inset)
        return RoundedRectangle(cornerRadius: radius(for: box.size), style: .continuous).path(in: box)
    }
    func inset(by amount: CGFloat) -> TextCapsule {
        TextCapsule(maxRadius: max(maxRadius - amount, 0), inset: inset + amount)
    }
}

@available(iOS 26, *)
extension TextCapsule: RoundedRectangularShape {
    func corners(in size: CGSize?) -> RoundedRectangularShapeCorners? {
        .fixed(size.map { radius(for: $0) } ?? maxRadius)
    }
}

extension View {
    /// Marks the composer's `shape` as the container that concentric fills inside it follow on
    /// iOS 26. Earlier systems keep the fixed nested radius each fill names.
    @ViewBuilder func aceContainerShape(_ shape: TextCapsule) -> some View {
        if #available(iOS 26, *) { self.containerShape(shape) } else { self.containerShape(shape) }
    }

    /// A fill whose corners follow the nearest container (a sheet, the strip, the display) on
    /// iOS 26, never sharper than `minimum`; iOS 18 draws `minimum` itself.
    @ViewBuilder func aceConcentricBackground<Style: ShapeStyle>(_ style: Style, minimum: CGFloat) -> some View {
        if #available(iOS 26, *) {
            self.background(style, in: ConcentricRectangle.aceUniform(minimum))
        } else {
            self.background(style, in: RoundedRectangle(cornerRadius: minimum, style: .continuous))
        }
    }

    /// A hairline that follows the same concentric corners as `aceConcentricBackground`.
    @ViewBuilder func aceConcentricBorder<Style: ShapeStyle>(_ style: Style, minimum: CGFloat, lineWidth: CGFloat) -> some View {
        if #available(iOS 26, *) {
            self.overlay(ConcentricRectangle.aceUniform(minimum).stroke(style, lineWidth: lineWidth))
        } else {
            self.overlay(RoundedRectangle(cornerRadius: minimum, style: .continuous).strokeBorder(style, lineWidth: lineWidth))
        }
    }

    /// The touch area for a concentric fill.
    @ViewBuilder func aceConcentricContentShape(minimum: CGFloat) -> some View {
        if #available(iOS 26, *) {
            self.contentShape(ConcentricRectangle.aceUniform(minimum))
        } else {
            self.contentShape(RoundedRectangle(cornerRadius: minimum, style: .continuous))
        }
    }
}

@available(iOS 26, *)
private extension ConcentricRectangle {
    /// All four corners alike, concentric with the container, at least `minimum`.
    static func aceUniform(_ minimum: CGFloat) -> ConcentricRectangle {
        ConcentricRectangle(corners: .concentric(minimum: .fixed(minimum)), isUniform: true)
    }
}

extension AceTheme.Dimensions {
    /// The smallest a tap may land on (HIG): words, glyph buttons and pills reach at least this
    /// far even where they draw smaller.
    static let tapMinimum: CGFloat = 44
}

extension AceTheme.Spacing {
    /// One text edge for every list and page: 16pt from the screen's side (inbox, chats, pull
    /// requests, More and Settings alike).
    static let gutter: CGFloat = lg
    /// Inside a list row, past the row's own 8pt inset from the edge (`inboxRowChrome`): together
    /// they put its text on the gutter.
    static let rowInner: CGFloat = gutter - sm
}

