import SwiftUI
import UIKit

/// A bot's face, as the web's `SpadeFace` draws it: Spade's mark for Spade, the picture the person
/// uploaded, else the bot's initials on its colour. While it works the face breathes. Decorative:
/// the row or bubble around it carries the name.
struct SpadeBotFace: View {
    let model: ClientModel
    let face: SpadeModel.Face
    var size: CGFloat = AceDesign.Size.avatar
    var working = false
    @State private var picture: UIImage?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        content
            .frame(width: size, height: size)
            .clipShape(Circle())
            .opacity(working && !reduceMotion ? 0.7 : 1)
            .animation(working && !reduceMotion ? .easeInOut(duration: 0.9).repeatForever() : .default, value: working)
            .task(id: face.sha256) {
                guard face.kind == "image", let sha = face.sha256, let data = await model.spadeFace(sha) else { return }
                picture = UIImage(data: data)
            }
            .accessibilityHidden(true)
    }

    @ViewBuilder private var content: some View {
        if face.kind == "spade" {
            SpadeMark(size: size).foregroundStyle(AceTheme.Colours.foreground)
        } else if let picture {
            Image(uiImage: picture).resizable().scaledToFill()
        } else {
            ZStack {
                Circle().fill(face.fill.flatMap { Color(hexString: $0) } ?? AceTheme.Colours.fill)
                Text(face.initials ?? "?")
                    .font(.system(size: size * 0.4, weight: .semibold))
                    .foregroundStyle(.white)
                    .minimumScaleFactor(0.5)
            }
        }
    }
}
