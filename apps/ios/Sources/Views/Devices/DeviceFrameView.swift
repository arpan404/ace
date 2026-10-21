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

/// A device's body drawn around its screen, with the island, notch or camera hole the web's
/// frame shows, and an older iPhone's home button.
struct DeviceFrameView<Screen: View>: View {
    let geometry: DeviceFrameGeometry
    let layout: DeviceFrameLayout
    @ViewBuilder let screen: () -> Screen

    var body: some View {
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: geometry.bodyRadius * layout.unit, style: .continuous)
                .fill(Self.body)
                .overlay {
                    RoundedRectangle(cornerRadius: geometry.bodyRadius * layout.unit, style: .continuous)
                        .strokeBorder(Self.rim, lineWidth: 1.5)
                }
                .frame(width: layout.body.width, height: layout.body.height)
            screen()
                .frame(width: layout.screen.width, height: layout.screen.height)
                .overlay(alignment: .top) { cutout.allowsHitTesting(false) }
                .clipShape(RoundedRectangle(cornerRadius: geometry.screenRadius * layout.unit, style: .continuous))
                .offset(x: layout.screen.minX, y: layout.screen.minY)
            if geometry.homeButton {
                let size = geometry.bezel.bottom * layout.unit * 0.5
                Circle().strokeBorder(Self.rim, lineWidth: 1.5)
                    .frame(width: size, height: size)
                    .offset(x: layout.body.width / 2 - size / 2,
                            y: layout.screen.maxY + (layout.body.height - layout.screen.maxY - size) / 2)
                    .accessibilityHidden(true)
            }
        }
        .frame(width: layout.body.width, height: layout.body.height, alignment: .topLeading)
    }

    private static var body: Color { Color(red: 0.09, green: 0.09, blue: 0.1) }
    private static var rim: Color { Color(white: 0.28) }

    @ViewBuilder private var cutout: some View {
        let unit = layout.unit
        let cut = geometry.cutout
        switch cut.kind {
        case "island":
            Capsule().fill(.black)
                .frame(width: (cut.width ?? 0) * unit, height: (cut.height ?? 0) * unit)
                .padding(.top, (cut.top ?? 0) * unit)
        case "notch":
            UnevenRoundedRectangle(bottomLeadingRadius: (cut.height ?? 0) * unit * 0.45, bottomTrailingRadius: (cut.height ?? 0) * unit * 0.45)
                .fill(.black)
                .frame(width: (cut.width ?? 0) * unit, height: (cut.height ?? 0) * unit)
        case "punch":
            Circle().fill(.black)
                .frame(width: (cut.size ?? 0) * unit, height: (cut.size ?? 0) * unit)
                .padding(.top, (cut.top ?? 0) * unit)
        default:
            EmptyView()
        }
    }
}
