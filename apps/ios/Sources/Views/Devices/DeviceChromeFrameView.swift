import SwiftUI
import UIKit

/// A model's real look with its images decoded: the art as the bridge sent it, and each picture
/// ready to draw. Nil when the body's picture can't be read.
struct DeviceChromeLook: @unchecked Sendable {
    let art: DeviceChromeArt
    let body: UIImage
    let mask: UIImage?
    let cutout: UIImage?
    let buttons: [UIImage?]
    let pressed: [UIImage?]

    init?(_ art: DeviceChromeArt) {
        guard let body = Self.image(art.body) else { return nil }
        self.art = art
        self.body = body
        mask = art.mask.flatMap(Self.image)
        cutout = art.cutout.flatMap { Self.image($0.image) }
        buttons = art.buttons.map { Self.image($0.image) }
        pressed = art.buttons.map { $0.pressed.flatMap(Self.image) }
    }

    /// A `data:image/...;base64,` URL's picture.
    static func image(_ url: String) -> UIImage? {
        guard url.hasPrefix("data:image/"), let comma = url.firstIndex(of: ",") else { return nil }
        guard let data = Data(base64Encoded: String(url[url.index(after: comma)...])) else { return nil }
        return UIImage(data: data)
    }
}

/// A device drawn in its real body from its SDK, as the web's `ChromeFrame` draws it: the body
/// upright and turned with the device, the screen unturned in the box so touches land where the
/// picture is, clipped to the screen's exact shape, a notch over it where the hardware has one,
/// and the body's buttons, pressable when `press` is given.
struct DeviceChromeFrameView<Screen: View>: View {
    let look: DeviceChromeLook
    let turn: DeviceRotation
    let room: CGSize
    var enabled = false
    var press: ((String) -> Void)?
    @ViewBuilder let screen: () -> Screen

    private var layout: DeviceChromeArt.Turn {
        let index = DeviceRotation.allCases.firstIndex(of: turn) ?? 0
        return look.art.turns.indices.contains(index) ? look.art.turns[index] : look.art.turns[0]
    }

    /// Never larger than one point per device point.
    private var scale: CGFloat {
        let box = layout.box
        guard box.width > 0, box.height > 0 else { return 0 }
        return max(0, min(room.width / box.width, room.height / box.height, 1))
    }

    var body: some View {
        let s = scale, box = layout.box, plate = layout.plate, shown = layout.screen
        let plateSize = CGSize(width: plate.width * s, height: plate.height * s)
        ZStack(alignment: .topLeading) {
            plateView(size: plateSize, onTop: false)
                .offset(x: plate.left * s, y: plate.top * s)
            screen()
                .frame(width: shown.width * s, height: shown.height * s)
                .mask { maskView(CGSize(width: shown.width * s, height: shown.height * s)) }
                .offset(x: shown.left * s, y: shown.top * s)
            plateView(size: plateSize, onTop: true)
                .offset(x: plate.left * s, y: plate.top * s)
        }
        .frame(width: box.width * s, height: box.height * s, alignment: .topLeading)
        .accessibilityElement(children: .contain)
    }

    /// The upright body at `size`, turned about its centre: behind the screen, its body art and
    /// the buttons tucked behind its edge; over it, the notch and buttons on its face.
    private func plateView(size: CGSize, onTop: Bool) -> some View {
        ZStack(alignment: .topLeading) {
            if !onTop {
                ForEach(buttonIndices(onTop: false), id: \.self) { button($0, plate: size) }
                Image(uiImage: look.body).resizable().frame(width: size.width, height: size.height)
                    .allowsHitTesting(false).accessibilityHidden(true)
            } else {
                if let cutout = look.cutout, let rect = look.art.cutout?.rect {
                    Image(uiImage: cutout).resizable()
                        .frame(width: rect.width * size.width, height: rect.height * size.height)
                        .offset(x: rect.x * size.width, y: rect.y * size.height)
                        .allowsHitTesting(false).accessibilityHidden(true)
                }
                ForEach(buttonIndices(onTop: true), id: \.self) { button($0, plate: size) }
            }
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .rotationEffect(.degrees(Double(turn.rawValue)))
    }

    private func buttonIndices(onTop: Bool) -> [Int] {
        look.art.buttons.indices.filter { look.art.buttons[$0].onTop == onTop }
    }

    @ViewBuilder private func button(_ index: Int, plate: CGSize) -> some View {
        let art = look.art.buttons[index]
        let frame = CGRect(x: art.rect.x * plate.width, y: art.rect.y * plate.height,
                           width: art.rect.width * plate.width, height: art.rect.height * plate.height)
        if let image = look.buttons[index] {
            if let press, !art.key.isEmpty {
                Button { press(art.key) } label: {
                    Image(uiImage: image).resizable().frame(width: frame.width, height: frame.height)
                        // Room for a finger around a sliver of metal.
                        .padding(8).contentShape(Rectangle()).padding(-8)
                }
                .buttonStyle(ChromeButtonStyle(pressed: look.pressed[index], size: frame.size))
                .disabled(!enabled)
                .accessibilityLabel(art.label)
                .offset(x: frame.minX, y: frame.minY)
            } else {
                Image(uiImage: image).resizable().frame(width: frame.width, height: frame.height)
                    .offset(x: frame.minX, y: frame.minY)
                    .allowsHitTesting(false).accessibilityHidden(true)
            }
        }
    }

    /// The screen's exact shape, turned with the body; the whole screen when the SDK has none.
    @ViewBuilder private func maskView(_ size: CGSize) -> some View {
        if let mask = look.mask {
            let upright = turn.swapsSides ? CGSize(width: size.height, height: size.width) : size
            Image(uiImage: mask).resizable()
                .frame(width: upright.width, height: upright.height)
                .rotationEffect(.degrees(Double(turn.rawValue)))
                .frame(width: size.width, height: size.height)
        } else {
            Rectangle()
        }
    }
}

/// A hardware button shows its pressed picture while held, as Simulator's does.
private struct ChromeButtonStyle: ButtonStyle {
    let pressed: UIImage?
    let size: CGSize
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.overlay {
            if configuration.isPressed, let pressed {
                Image(uiImage: pressed).resizable().frame(width: size.width, height: size.height)
            }
        }
    }
}
