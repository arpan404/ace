import SwiftUI

/// Spade's mark, drawn natively from the web's geometry (`spade-mark.tsx`, ui-core `spade-look.ts`): a
/// round head in the current text colour with two egg-shaped eyes resting low and a hair left,
/// the face tilted -4°. The eyes are always paper white with near-black outlines and pupils,
/// whatever the theme. At 24pt and under the outline thickens, the pupils grow and the
/// catchlight goes, so the face still reads. Decorative: the button around it carries the name.
struct SpadeMark: View {
    var size: CGFloat = AceDesign.Size.barIcon

    private static let paper = Color(red: 0xF6 / 255, green: 0xF6 / 255, blue: 0xF7 / 255)
    private static let ink = Color(red: 0x14 / 255, green: 0x14 / 255, blue: 0x16 / 255)

    var body: some View {
        let face = SpadeFace(size: size)
        ZStack {
            // The head, r = 10.6 of 24, in the current text colour.
            Circle().inset(by: 1.4 * face.unit)
            ZStack {
                ForEach(SpadeFace.eyes.indices, id: \.self) { index in
                    let centre = SpadeFace.eyes[index]
                    SpadeEgg(centre: centre, rx: SpadeFace.eye.width + face.ring, ry: SpadeFace.eye.height + face.ring).fill(Self.ink)
                    SpadeEgg(centre: centre, rx: SpadeFace.eye.width, ry: SpadeFace.eye.height).fill(Self.paper)
                    SpadeDot(centre: face.pupil(in: centre), rx: face.pupilSize.width, ry: face.pupilSize.height).fill(Self.ink)
                    if let glint = face.glint(in: centre) {
                        SpadeDot(centre: glint.centre, rx: glint.radius, ry: glint.radius).fill(Self.paper)
                    }
                }
            }
            .rotationEffect(.degrees(SpadeFace.tilt))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// The face's geometry in the web's 24-unit box (ui-core `spade-look.ts`): where the eyes sit, how big
/// the pupils are at this size, and where they rest.
struct SpadeFace {
    let size: CGFloat
    nonisolated static let eyes = [CGPoint(x: 8.7, y: 11.9), CGPoint(x: 15.3, y: 11.9)]
    nonisolated static let eye = CGSize(width: 2.3, height: 3.55)
    /// Where the pupils rest: low and a hair to the left.
    nonisolated static let rest = CGPoint(x: -0.25, y: 2)
    nonisolated static let tilt = -4.0
    /// 24pt and under: a thicker ring, bigger pupils, no catchlight.
    var small: Bool { size <= 24 }
    var unit: CGFloat { size / 24 }
    var ring: CGFloat { small ? 1.15 : size <= 40 ? 0.85 : 0.62 }
    var pupilSize: CGSize { small ? CGSize(width: 1.25, height: 1.8) : CGSize(width: 1.1, height: 1.6) }
    private var pad: CGFloat { small ? 0.02 : 0.22 }

    /// The pupil's centre in the eye at `centre`, kept inside the eye (`clampSpadeLook`).
    func pupil(in centre: CGPoint) -> CGPoint {
        let ax = Self.eye.width - pupilSize.width - pad, ay = Self.eye.height - pupilSize.height - pad
        let look = Self.rest
        let reach = (look.x * look.x) / (ax * ax) + (look.y * look.y) / (ay * ay)
        let scale = reach > 1 ? 1 / reach.squareRoot() : 1
        return CGPoint(x: centre.x + look.x * scale, y: centre.y + look.y * scale)
    }
    /// The catchlight over the pupil, above 24pt only.
    func glint(in centre: CGPoint) -> (centre: CGPoint, radius: CGFloat)? {
        guard !small else { return nil }
        let at = pupil(in: centre)
        return (CGPoint(x: at.x + pupilSize.width * 0.38, y: at.y - pupilSize.height * 0.42), pupilSize.width * 0.3)
    }
}

/// An egg in the 24-unit box, scaled to the frame: flatter on top, fuller below (the web's
/// `egg()` curve).
struct SpadeEgg: Shape {
    let centre: CGPoint
    let rx: CGFloat
    let ry: CGFloat
    func path(in rect: CGRect) -> Path {
        let k = rect.width / 24
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + (centre.x + x) * k, y: rect.minY + (centre.y + y) * k) }
        var path = Path()
        path.move(to: p(0, -ry))
        path.addCurve(to: p(rx, ry * 0.12), control1: p(rx * 0.78, -ry), control2: p(rx, -ry * 0.36))
        path.addCurve(to: p(0, ry), control1: p(rx, ry * 0.66), control2: p(rx * 0.58, ry))
        path.addCurve(to: p(-rx, ry * 0.12), control1: p(-rx * 0.58, ry), control2: p(-rx, ry * 0.66))
        path.addCurve(to: p(0, -ry), control1: p(-rx, -ry * 0.36), control2: p(-rx * 0.78, -ry))
        path.closeSubpath()
        return path
    }
}

/// An ellipse in the 24-unit box, scaled to the frame: a pupil or a catchlight.
struct SpadeDot: Shape {
    let centre: CGPoint
    let rx: CGFloat
    let ry: CGFloat
    func path(in rect: CGRect) -> Path {
        let k = rect.width / 24
        return Path(ellipseIn: CGRect(x: rect.minX + (centre.x - rx) * k, y: rect.minY + (centre.y - ry) * k, width: rx * 2 * k, height: ry * 2 * k))
    }
}

extension SpadeMark {
    /// The mark as the tab bar draws it: one colour, the eyes cut out of the head with their
    /// pupils left in, so the same face reads in the bar's tint (a template image).
    @MainActor static let tabImage: UIImage = {
        // The system tab bar's glyph size; the image is a template, so black is only its mask.
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
            for centre in SpadeFace.eyes {
                var cut = context
                cut.blendMode = .destinationOut
                let box = CGRect(x: 0, y: 0, width: 24, height: 24)
                let face = SpadeFace(size: 24)
                cut.fill(SpadeEgg(centre: centre, rx: SpadeFace.eye.width, ry: SpadeFace.eye.height).path(in: box), with: .color(.black))
                // Pupils resting low and a hair left, as the mark's rest look.
                context.fill(SpadeDot(centre: face.pupil(in: centre), rx: face.pupilSize.width, ry: face.pupilSize.height).path(in: box), with: .color(.black))
            }
        }
    }
}
