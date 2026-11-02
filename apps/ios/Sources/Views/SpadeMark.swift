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

/// Spade in the Threads header, before it launches: its mark as a button that says, in one
/// sentence, that it is coming (the web rail's "Spade · Coming soon").
struct SpadeSoonButton: View {
    var size: CGFloat = 24
    /// Draws the button as the drawer header's own (a full touch target) rather than a bar item.
    var framed = false
    @State private var showing = false

    var body: some View {
        Button { showing = true } label: {
            SpadeMark(size: size)
                .foregroundStyle(AceTheme.Colours.foreground)
                .frame(width: framed ? AceTheme.Dimensions.touchTarget : nil, height: framed ? AceTheme.Dimensions.touchTarget : nil)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Spade, coming soon")
        .accessibilityIdentifier("inbox.spade")
        .popover(isPresented: $showing, arrowEdge: .top) {
            Text("Spade is coming soon.")
                .aceFont(AceTheme.Typography.body, relativeTo: .body)
                .foregroundStyle(AceTheme.Colours.foreground)
                .padding(.horizontal, AceTheme.Spacing.xl)
                .padding(.vertical, AceTheme.Spacing.lg)
                .fixedSize()
                .presentationCompactAdaptation(.popover)
                .accessibilityIdentifier("spade.soon")
        }
    }
}
