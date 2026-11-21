import SwiftUI

/// One face as the bridge put it: Spade's own mark for Spade, else its character face. An away
/// member's face is dimmed. Keeps the initial only as an accessibility label fallback when shown
/// non-decoratively; by default decorative because the row or bubble beside it names the bot.
struct SpadeFaceView: View {
    let face: SpadeModel.Face
    var size: CGFloat = AceDesign.Size.tap - AceDesign.Space.tight
    /// What the face expresses (working moves the eyes; needs-you tilts and widens; etc.).
    var pose: BotFacePose = .idle
    var decorative = true

    var body: some View {
        Group {
            if face.main {
                SpadeMark(size: size, moving: pose.isMoving).foregroundStyle(AceDesign.Ink.primary)
            } else {
                BotFaceView(face: face.character ?? .default, size: size, pose: pose)
            }
        }
        .opacity(face.away ? AceTheme.Opacity.disabled(.light) : 1)
        .accessibilityLabel(face.main ? "Spade" : face.initial)
        .accessibilityHidden(decorative)
    }
}

/// A group's face: up to three members' faces in one square, each cut from the next by the
/// page's colour, so the stack reads as one face at a glance.
struct SpadeGroupFaces: View {
    let faces: [SpadeModel.Face]
    var size: CGFloat = AceDesign.Size.tap - AceDesign.Space.tight

    /// Where each face sits, as fractions of the square's side.
    private var places: [CGPoint] {
        faces.count >= 3
            ? [CGPoint(x: 0.2, y: 0), CGPoint(x: 0, y: 0.4), CGPoint(x: 0.4, y: 0.4)]
            : [CGPoint(x: 0, y: 0), CGPoint(x: 0.4, y: 0.4)]
    }

    var body: some View {
        if faces.count < 2, let only = faces.first {
            SpadeFaceView(face: only, size: size)
        } else {
            let small = (size * 0.6).rounded()
            ZStack(alignment: .topLeading) {
                ForEach(Array(zip(faces.prefix(3), places).enumerated()), id: \.offset) { _, pair in
                    SpadeFaceView(face: pair.0, size: small)
                        .padding(AceTheme.Dimensions.border * 1.5)
                        .background(AceDesign.Surface.background, in: Circle())
                        .offset(x: pair.1.x * size - AceTheme.Dimensions.border * 1.5,
                                y: pair.1.y * size - AceTheme.Dimensions.border * 1.5)
                }
            }
            .frame(width: size, height: size, alignment: .topLeading)
            .accessibilityHidden(true)
        }
    }
}

/// A row's face: the bot's, or a group's stack, with an amber dot while it needs the person,
/// red when it failed, grey while it is off.
struct SpadeBotFace: View {
    let bot: SpadeModel.Bot
    private static let size = AceDesign.Size.tap - AceDesign.Space.tight
    var body: some View {
        Group {
            if bot.group != nil {
                SpadeGroupFaces(faces: bot.faces, size: Self.size)
            } else if let face = bot.faces.first {
                SpadeFaceView(face: face, size: Self.size, pose: pose)
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if let dot {
                Circle().fill(dot)
                    .frame(width: AceDesign.Size.dot, height: AceDesign.Size.dot)
                    .overlay(Circle().stroke(AceDesign.Surface.background, lineWidth: AceTheme.Dimensions.border * 2))
            }
        }
        .accessibilityHidden(true)
    }

    private var pose: BotFacePose {
        switch bot.state {
        case "needs-you": .needsYou
        case "working": .working
        case "failed": .blocked
        case "unseen": .done
        default: .idle
        }
    }

    private var dot: Color? {
        switch bot.state {
        case "needs-you": AceDesign.Status.needsYou
        case "failed": AceDesign.Status.failed
        case "off": AceDesign.Ink.faint
        default: nil
        }
    }
}
