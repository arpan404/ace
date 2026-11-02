import SwiftUI

/// Spade's mark, drawn natively from the web's geometry (`spade-mark.tsx`, `spade-look.ts`): a
/// round head in the current text colour with two egg-shaped eyes resting low and a hair left,
/// the face tilted -4°. The eyes are always paper white with near-black outlines and pupils,
/// whatever the theme. At 24pt and under the outline thickens, the pupils grow and the
/// catchlight goes, so the face still reads. Decorative: the button around it carries the name.
struct SpadeMark: View {
    var size: CGFloat = 20

    private static let paper = Color(red: 0xF6 / 255, green: 0xF6 / 255, blue: 0xF7 / 255)
    private static let ink = Color(red: 0x14 / 255, green: 0x14 / 255, blue: 0x16 / 255)
    private static let eyes = [CGPoint(x: 8.7, y: 11.9), CGPoint(x: 15.3, y: 11.9)]
    private static let eye = CGSize(width: 2.3, height: 3.55)
    private static let rest = CGPoint(x: -0.25, y: 2)
    private static let tilt = -4.0

    var body: some View {
        let small = size <= 24
        let ring: CGFloat = small ? 1.15 : size <= 40 ? 0.85 : 0.62
        let pupil = small ? CGSize(width: 1.25, height: 1.8) : CGSize(width: 1.1, height: 1.6)
        let look = Self.clamped(Self.rest, pupil: pupil, pad: small ? 0.02 : 0.22)
        Canvas { context, canvas in
            let scale = canvas.width / 24
            context.scaleBy(x: scale, y: scale)
            context.fill(Path(ellipseIn: CGRect(x: 1.4, y: 1.4, width: 21.2, height: 21.2)), with: .foreground)
            context.translateBy(x: 12, y: 12)
            context.rotate(by: .degrees(Self.tilt))
            context.translateBy(x: -12, y: -12)
            for centre in Self.eyes {
                context.fill(Self.egg(centre, rx: Self.eye.width + ring, ry: Self.eye.height + ring), with: .color(Self.ink))
                context.fill(Self.egg(centre, rx: Self.eye.width, ry: Self.eye.height), with: .color(Self.paper))
                let at = CGPoint(x: centre.x + look.x, y: centre.y + look.y)
                context.fill(Path(ellipseIn: CGRect(x: at.x - pupil.width, y: at.y - pupil.height,
                                                    width: pupil.width * 2, height: pupil.height * 2)), with: .color(Self.ink))
                if !small {
                    let glint = CGPoint(x: at.x + pupil.width * 0.38, y: at.y - pupil.height * 0.42)
                    let r = pupil.width * 0.3
                    context.fill(Path(ellipseIn: CGRect(x: glint.x - r, y: glint.y - r, width: r * 2, height: r * 2)), with: .color(Self.paper))
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    /// The pupils' place, kept inside the eye (`clampSpadeLook`).
    private static func clamped(_ look: CGPoint, pupil: CGSize, pad: CGFloat) -> CGPoint {
        let ax = eye.width - pupil.width - pad, ay = eye.height - pupil.height - pad
        let reach = (look.x * look.x) / (ax * ax) + (look.y * look.y) / (ay * ay)
        guard reach > 1 else { return look }
        let scale = 1 / reach.squareRoot()
        return CGPoint(x: look.x * scale, y: look.y * scale)
    }

    /// An egg: flatter on top, fuller below.
    private static func egg(_ c: CGPoint, rx: CGFloat, ry: CGFloat) -> Path {
        var path = Path()
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: c.x + x, y: c.y + y) }
        path.move(to: p(0, -ry))
        path.addCurve(to: p(rx, ry * 0.12), control1: p(rx * 0.78, -ry), control2: p(rx, -ry * 0.36))
        path.addCurve(to: p(0, ry), control1: p(rx, ry * 0.66), control2: p(rx * 0.58, ry))
        path.addCurve(to: p(-rx, ry * 0.12), control1: p(-rx * 0.58, ry), control2: p(-rx, ry * 0.66))
        path.addCurve(to: p(0, -ry), control1: p(-rx, -ry * 0.36), control2: p(-rx * 0.78, -ry))
        path.closeSubpath()
        return path
    }
}

extension SpadeMark {
    /// The mark as the tab bar draws it: one colour, the eyes cut out of the head with their
    /// pupils left in, so the same face reads in the bar's tint (a template image).
    @MainActor static let tabImage: UIImage = {
        let size: CGFloat = 26
        let renderer = ImageRenderer(content: SpadeGlyph().frame(width: size, height: size))
        renderer.scale = 3
        return (renderer.uiImage ?? UIImage()).withRenderingMode(.alwaysTemplate)
    }()
}

/// The mark in one colour: the head, its eyes cut out, the pupils inside them.
private struct SpadeGlyph: View {
    var body: some View {
        Canvas { context, canvas in
            let scale = canvas.width / 24
            context.scaleBy(x: scale, y: scale)
            context.fill(Path(ellipseIn: CGRect(x: 1.4, y: 1.4, width: 21.2, height: 21.2)), with: .color(.black))
            context.translateBy(x: 12, y: 12)
            context.rotate(by: .degrees(-4))
            context.translateBy(x: -12, y: -12)
            for centre in [CGPoint(x: 8.7, y: 11.9), CGPoint(x: 15.3, y: 11.9)] {
                var cut = context
                cut.blendMode = .destinationOut
                cut.fill(Path(ellipseIn: CGRect(x: centre.x - 2.3, y: centre.y - 3.55, width: 4.6, height: 7.1)), with: .color(.black))
                // Pupils resting low and a hair left, as the mark's rest look.
                let at = CGPoint(x: centre.x - 0.21, y: centre.y + 1.69)
                context.fill(Path(ellipseIn: CGRect(x: at.x - 1.25, y: at.y - 1.8, width: 2.5, height: 3.6)), with: .color(.black))
            }
        }
    }
}

/// The Spade tab before Spade launches: its mark and one quiet sentence, centred.
struct SpadeSoonScreen: View {
    var body: some View {
        VStack(spacing: AceTheme.Spacing.lg) {
            SpadeMark(size: 56).foregroundStyle(AceTheme.Colours.foreground)
            Text("Spade is coming soon.")
                .aceFont(AceTheme.Typography.body, relativeTo: .body)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .accessibilityIdentifier("spade.soon")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(AceTheme.Colours.background)
        .accessibilityElement(children: .combine)
    }
}
