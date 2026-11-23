import SwiftUI

struct FleetMapCanvas: View {
    let picture: FleetPicture
    let summary: String
    let open: (String) -> Void

    @State private var zoom: CGFloat = 1
    @State private var origin: CGSize = .zero
    @GestureState private var pinch: MagnifyGesture.Value?
    @GestureState private var drag: CGSize = .zero

    var body: some View {
        GeometryReader { proxy in
            let size = proxy.size
            let scale = size.width / picture.width * visibleZoom
            let offset = visibleOrigin(in: size)
            let pan = DragGesture()
                .updating($drag) { value, state, _ in state = value.translation }
                .onEnded { value in
                    origin = bounded(offsetBy(value.translation), zoom: zoom, in: size)
                }
            ZStack(alignment: .topLeading) {
                AceDesign.Surface.background
                drawing
                    .scaleEffect(scale, anchor: .topLeading)
                    .offset(offset)
                    .allowsHitTesting(false)
            }
            // Keep the viewport fixed while the picture transforms inside it.
            .frame(width: size.width, height: size.height, alignment: .topLeading)
            .clipShape(AceDesign.Shape.block)
            .contentShape(Rectangle())
            .simultaneousGesture(SpatialTapGesture().onEnded { tap in
                select(at: tap.location, scale: scale, offset: offset)
            })
            .gesture(pan, including: zoom > 1 && pinch == nil ? .all : .none)
            .simultaneousGesture(
                MagnifyGesture()
                    .updating($pinch) { value, state, _ in state = value }
                    .onEnded { value in
                        let next = limitedZoom(value.magnification)
                        origin = pinchedOrigin(value.startAnchor, zoom: next, in: size)
                        zoom = next
                    }
            )
        }
        .aspectRatio(picture.width / picture.height, contentMode: .fit)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Fleet map")
        .accessibilityValue(summary)
        .accessibilityIdentifier("fleetMap.summary")
    }

    private var drawing: some View {
        ZStack(alignment: .topLeading) {
            Canvas { context, _ in
                for zone in picture.zones {
                    let region = Path(roundedRect: zone.box.rect, cornerRadius: AceDesign.Corner.blockFloor)
                    context.fill(region, with: .color(AceDesign.Surface.fill.opacity(0.55)))
                    context.stroke(region, with: .color(AceDesign.Ink.faint.opacity(0.4)), lineWidth: 1)
                }
                for wire in picture.wires { draw(wire, in: context) }
                for zone in picture.zones {
                    let text = Text(zone.name).font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                    context.draw(text, at: CGPoint(x: zone.label.x, y: zone.label.y),
                                 anchor: zone.label.anchor == "end" ? .bottomTrailing : .bottomLeading)
                }
            }
            if let cloud = picture.cloud {
                VStack(spacing: AceDesign.Space.tight) {
                    AceIcon(.cloud, size: AceDesign.Size.emptyIcon)
                    Text(cloud.label).font(AceDesign.Typeface.meta)
                }
                .foregroundStyle(AceDesign.Ink.muted)
                .position(x: cloud.x, y: cloud.y)
            }
            ForEach(picture.nodes) { node in
                tile(node)
                    .position(x: node.x, y: node.y)
            }
        }
        .frame(width: picture.width, height: picture.height)
        .dynamicTypeSize(.large)
    }

    private func tile(_ node: FleetPicture.Node) -> some View {
        AceIcon(FleetMapReply.icon(node.mark), size: AceDesign.Size.emptyIcon)
            .foregroundStyle(AceDesign.Ink.primary)
            .frame(width: AceDesign.Size.tap, height: AceDesign.Size.tap)
            .background(AceDesign.Surface.raised, in: AceDesign.Shape.block)
            .overlay(alignment: .topTrailing) {
                FleetDot(token: node.token).padding(AceDesign.Space.tight)
            }
            .overlay(alignment: .bottom) {
                VStack(spacing: 0) {
                    Text(node.label).font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.primary)
                    Text(node.status).font(AceDesign.Typeface.caption).foregroundStyle(AceDesign.Ink.muted)
                }
                .lineLimit(1)
                .frame(width: 120)
                .fixedSize(horizontal: true, vertical: true)
                .alignmentGuide(.bottom) { _ in -AceDesign.Space.tight }
            }
    }

    private func draw(_ wire: FleetPicture.Wire, in context: GraphicsContext) {
        guard let first = wire.points.first?.cg else { return }
        var path = Path()
        path.move(to: first)
        if wire.points.count == 2, let end = wire.points.last?.cg, abs(first.y - end.y) > 1 {
            let middle = (first.y + end.y) / 2
            path.addCurve(to: end, control1: CGPoint(x: first.x, y: middle), control2: CGPoint(x: end.x, y: middle))
        } else {
            for point in wire.points.dropFirst() { path.addLine(to: point.cg) }
        }
        let color: Color
        let dash: [CGFloat]
        switch wire.kind {
        case "broken": (color, dash) = (AceDesign.Status.failed, [3, 4])
        case "needs": (color, dash) = (AceDesign.Status.needsYou, wire.relayed ? [6, 5] : [])
        case "unknown": (color, dash) = (AceDesign.Ink.subtle.opacity(0.6), [2, 4])
        default: (color, dash) = (AceDesign.Ink.muted.opacity(0.6), wire.relayed ? [6, 5] : [])
        }
        context.stroke(path, with: .color(color),
                       style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round, dash: dash))
    }

    private var visibleZoom: CGFloat { limitedZoom(pinch?.magnification ?? 1) }

    private func limitedZoom(_ factor: CGFloat) -> CGFloat { min(6, max(1, zoom * factor)) }

    private func offsetBy(_ delta: CGSize) -> CGSize {
        CGSize(width: origin.width + delta.width, height: origin.height + delta.height)
    }

    private func bounded(_ offset: CGSize, zoom: CGFloat, in size: CGSize) -> CGSize {
        CGSize(width: min(0, max(offset.width, size.width * (1 - zoom))),
               height: min(0, max(offset.height, size.height * (1 - zoom))))
    }

    private func pinchedOrigin(_ anchor: UnitPoint, zoom next: CGFloat, in size: CGSize) -> CGSize {
        let ratio = next / zoom
        return bounded(CGSize(width: origin.width * ratio + anchor.x * size.width * (1 - ratio),
                              height: origin.height * ratio + anchor.y * size.height * (1 - ratio)),
                       zoom: next, in: size)
    }

    private func visibleOrigin(in size: CGSize) -> CGSize {
        if let pinch { return pinchedOrigin(pinch.startAnchor, zoom: visibleZoom, in: size) }
        return bounded(offsetBy(drag), zoom: zoom, in: size)
    }

    private func select(at point: CGPoint, scale: CGFloat, offset: CGSize) {
        guard scale > 0 else { return }
        let hit = CGPoint(x: (point.x - offset.width) / scale, y: (point.y - offset.height) / scale)
        let minimum = AceDesign.Size.tap / (2 * scale)
        let nearest = picture.nodes.compactMap { node -> (id: String, distance: CGFloat)? in
            let x = hit.x - node.x
            let y = hit.y - node.y
            guard abs(x) <= max(60, minimum), y >= -max(34, minimum), y <= max(58, minimum) else { return nil }
            return (node.id, hypot(x, y))
        }.min { $0.distance < $1.distance }
        if let nearest { open(nearest.id) }
    }
}
