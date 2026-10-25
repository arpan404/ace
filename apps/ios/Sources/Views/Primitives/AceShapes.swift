import SwiftUI

/// Every corner in the app, in one place, the way iOS 26 rounds things: controls are capsules,
/// surfaces that grow with their text are capsules until they wrap, and containers nest
/// concentrically inside their parent and the display (DESIGN.md §2: inner radius = outer radius
/// − the inset between them). Views name a shape from here and never write a radius of their own.
@MainActor enum AceShape {
    /// Buttons, pills, chips, toasts, search and one-line fields, pressed fills on small text actions.
    static let capsule = Capsule(style: .continuous)
    /// The composer and its strip, and the fields inside cards that take several lines: a full
    /// capsule while one line tall, then the composer's radius.
    static let field = TextCapsule(maxRadius: AceTheme.Radii.composer)
    /// The request above the composer: a grouped list at the composer's radius.
    static let group = rounded(AceTheme.Radii.composer)
    /// The person's message: a capsule for a short line, the bubble radius once it wraps.
    static let bubble = TextCapsule(maxRadius: AceTheme.Radii.bubble)
    /// Code inside the person's message: concentric with the bubble's padding.
    static let bubbleInset = rounded(nested(in: AceTheme.Radii.bubble, inset: AceTheme.Spacing.md))
    /// Code blocks, cards and screenshots: the content block radius.
    static let block = rounded(AceTheme.Radii.card)
    /// A row's pressed or selected fill: this radius on iOS 18, and the floor of its concentric
    /// corners on iOS 26.
    static let rowRadius = AceTheme.Radii.lg
    /// The tiny drawn glyphs (the Stop square, a file-status box, the tab count): radius scales
    /// with the glyph, never a capsule.
    static let stopGlyph = rounded(AceTheme.Radii.xs / 2)
    static let glyph = rounded(AceTheme.Radii.sm)

    /// A fixed corner, always continuous like the system's own.
    static func rounded(_ radius: CGFloat) -> RoundedRectangle {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
    }
    /// The concentric radius inside `outer` at `inset` from its edge, never sharper than `xs`.
    nonisolated static func nested(in outer: CGFloat, inset: CGFloat) -> CGFloat {
        max(outer - inset, AceTheme.Radii.xs)
    }
}

/// A capsule whose radius stops growing at `maxRadius`, so a one-line surface is fully round and a
/// tall one keeps sensible corners instead of turning into a lozenge.
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
            self.background(style, in: AceShape.rounded(minimum))
        }
    }

    /// A hairline that follows the same concentric corners as `aceConcentricBackground`.
    @ViewBuilder func aceConcentricBorder<Style: ShapeStyle>(_ style: Style, minimum: CGFloat, lineWidth: CGFloat) -> some View {
        if #available(iOS 26, *) {
            self.overlay(ConcentricRectangle.aceUniform(minimum).stroke(style, lineWidth: lineWidth))
        } else {
            self.overlay(AceShape.rounded(minimum).strokeBorder(style, lineWidth: lineWidth))
        }
    }

    /// The touch area for a concentric fill.
    @ViewBuilder func aceConcentricContentShape(minimum: CGFloat) -> some View {
        if #available(iOS 26, *) {
            self.contentShape(ConcentricRectangle.aceUniform(minimum))
        } else {
            self.contentShape(AceShape.rounded(minimum))
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
