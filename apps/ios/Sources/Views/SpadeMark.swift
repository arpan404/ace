import SwiftUI

/// Spade's mark, drawn natively from the web's geometry (`spade-mark.tsx`, ui-core `spade-look.ts`): a
/// round head in the current text colour with two egg-shaped eyes resting low and a hair left,
/// the face tilted -4°. The eyes are always paper white with near-black outlines and pupils,
/// whatever the theme. At 24pt and under the outline thickens, the pupils grow and the
/// catchlight goes, so the face still reads. While a Spade bot works the eyes move (`moving`).
/// Decorative: the button around it carries the name.
struct SpadeMark: View {
    var size: CGFloat = AceDesign.Size.barIcon
    /// A Spade bot works: the pupils look around and the eyes blink now and then (`SpadeMotion`),
    /// until it stops. Still under Reduce Motion.
    var moving = false
    @Environment(\.aceReduceMotion) private var reduceMotion

    private static let paper = Color(red: 0xF6 / 255, green: 0xF6 / 255, blue: 0xF7 / 255)
    private static let ink = Color(red: 0x14 / 255, green: 0x14 / 255, blue: 0x16 / 255)

    var body: some View {
        Group {
            if moving && !reduceMotion {
                // Only this mark redraws on the timeline: two eyes, a few small shapes.
                TimelineView(.animation) { context in
                    let seconds = context.date.timeIntervalSinceReferenceDate
                    face(look: SpadeMotion.look(at: seconds), open: SpadeMotion.blink(at: seconds))
                }
            } else {
                face(look: .zero, open: 1)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    /// The face with its pupils moved by `look` (24-unit box) and its eyes `open` (1 open).
    private func face(look: CGPoint, open: CGFloat) -> some View {
        let face = SpadeFace(size: size)
        return ZStack {
            // The head, r = 10.6 of 24, in the current text colour.
            Circle().inset(by: 1.4 * face.unit)
            ZStack {
                ForEach(SpadeFace.eyes.indices, id: \.self) { index in
                    eye(face, centre: SpadeFace.eyes[index], look: look)
                        // Each eye closes about its own middle, as the web's `fill-box` origin.
                        .scaleEffect(x: 1, y: open, anchor: UnitPoint(x: SpadeFace.eyes[index].x / 24, y: SpadeFace.eyes[index].y / 24))
                }
            }
            .rotationEffect(.degrees(SpadeFace.tilt))
        }
    }

    private func eye(_ face: SpadeFace, centre: CGPoint, look: CGPoint) -> some View {
        ZStack {
            SpadeEgg(centre: centre, rx: SpadeFace.eye.width + face.ring, ry: SpadeFace.eye.height + face.ring).fill(Self.ink)
            SpadeEgg(centre: centre, rx: SpadeFace.eye.width, ry: SpadeFace.eye.height).fill(Self.paper)
            ZStack {
                SpadeDot(centre: face.pupil(in: centre), rx: face.pupilSize.width, ry: face.pupilSize.height).fill(Self.ink)
                if let glint = face.glint(in: centre) {
                    SpadeDot(centre: glint.centre, rx: glint.radius, ry: glint.radius).fill(Self.paper)
                }
            }
            .offset(x: look.x * face.unit, y: look.y * face.unit)
        }
    }
}

/// The face's geometry in the web's 24-unit box (ui-core `spade-look.ts`, generated as
/// `SpadeGeometry`): where the eyes sit, how big the pupils are at this size, and where they rest.
struct SpadeFace {
    let size: CGFloat
    nonisolated static let eyes = SpadeGeometry.eyes
    nonisolated static let eye = SpadeGeometry.eye
    /// Where the pupils rest: low and a hair to the left.
    nonisolated static let rest = SpadeGeometry.rest
    nonisolated static let tilt = SpadeGeometry.tilt
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
