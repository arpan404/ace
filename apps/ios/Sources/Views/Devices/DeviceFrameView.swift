import SwiftUI

/// Where the body and the screen go in the room the stage has: the frame's bezels are fractions
/// of the screen's width (`@ace/ui-core/devices` frame geometry), the screen keeps its aspect,
/// and nothing is drawn larger than one point per device point.
struct DeviceFrameLayout: Equatable {
    let body: CGSize
    let screen: CGRect
    let unit: CGFloat

    init(room: CGSize, geometry: DeviceFrameGeometry, screen: CGSize) {
        let bezel = geometry.bezel
        let ratio = screen.width > 0 ? screen.height / screen.width : 0
        let across = 1 + bezel.left + bezel.right, down = ratio + bezel.top + bezel.bottom
        let unit = max(0, min(room.width / across, room.height / down, screen.width))
        self.unit = unit
        body = CGSize(width: across * unit, height: down * unit)
        self.screen = CGRect(x: bezel.left * unit, y: bezel.top * unit, width: unit, height: ratio * unit)
    }
}

/// A device drawn as the web draws it: a thin graphite band, black glass inside it, the screen
/// with the model's own corner radius, and an older device's home button. Nothing is painted
/// over the picture: the device's own pixels already show its island, notch or camera.
struct DeviceFrameView<Screen: View>: View {
    let geometry: DeviceFrameGeometry
    let layout: DeviceFrameLayout
    /// How far the body has turned: the home button follows the screen's bottom edge.
    var turn = DeviceRotation.none
    @ViewBuilder let screen: () -> Screen

    var body: some View {
        let bodyRadius = geometry.bodyRadius * layout.unit
        let band = geometry.band * layout.unit
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: bodyRadius, style: .continuous)
                .fill(Self.metal)
                .overlay {
                    // One soft lit edge, never a drawn outline.
                    RoundedRectangle(cornerRadius: bodyRadius, style: .continuous)
                        .strokeBorder(Self.edge, lineWidth: 0.5)
                }
                .overlay {
                    RoundedRectangle(cornerRadius: max(0, bodyRadius - band), style: .continuous)
                        .fill(.black)
                        .padding(band)
                }
                .frame(width: layout.body.width, height: layout.body.height)
            screen()
                .frame(width: layout.screen.width, height: layout.screen.height)
                .clipShape(RoundedRectangle(cornerRadius: geometry.screenRadius * layout.unit, style: .continuous))
                .offset(x: layout.screen.minX, y: layout.screen.minY)
            if geometry.homeButton { homeButton }
        }
        .frame(width: layout.body.width, height: layout.body.height, alignment: .topLeading)
        .accessibilityElement(children: .contain)
    }

    /// Centred in the bezel the screen's bottom faces once the body has turned (as the web's
    /// `homeBezel`): bottom, left, top, right for 0°, 90°, 180°, 270°.
    private var homeButton: some View {
        let bezel = geometry.bezel, unit = layout.unit
        let depth: CGFloat
        let x: CGFloat, y: CGFloat
        switch turn {
        case .none:
            depth = bezel.bottom * unit
            x = layout.body.width / 2 - depth / 4; y = layout.screen.maxY + depth / 4
        case .quarter:
            depth = bezel.left * unit
            x = depth / 4; y = layout.body.height / 2 - depth / 4
        case .half:
            depth = bezel.top * unit
            x = layout.body.width / 2 - depth / 4; y = depth / 4
        case .threeQuarters:
            depth = bezel.right * unit
            x = layout.screen.maxX + depth / 4; y = layout.body.height / 2 - depth / 4
        }
        let size = depth * 0.5
        return Circle().strokeBorder(Self.edge, lineWidth: 1)
            .frame(width: size, height: size)
            .offset(x: x, y: y)
            .accessibilityHidden(true)
    }

    private static var metal: Color { Color(red: 0.17, green: 0.17, blue: 0.185) }
    private static var edge: Color { Color.white.opacity(0.12) }
}
