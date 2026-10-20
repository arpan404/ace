import CoreGraphics

/// Where a device picture is drawn in a view, and where a finger in the view lands on the device.
/// The picture is turned by its rotation to stand upright, then fitted whole and centred. Pure.
///
/// Spaces: the *picture* is the encoded image (`width` × `height` pixels, as decoded); the view
/// shows it upright; the device takes input in points, which are picture pixels over `scale`.
struct DeviceViewport: Equatable, Sendable {
    let width: Double
    let height: Double
    let scale: Double
    let rotation: DeviceRotation
    let viewSize: CGSize

    init(width: Int, height: Int, scale: Double, rotation: DeviceRotation, viewSize: CGSize) {
        self.width = Double(width)
        self.height = Double(height)
        self.scale = scale
        self.rotation = rotation
        self.viewSize = viewSize
    }
    init(_ frame: DeviceFrameChunk, viewSize: CGSize) {
        self.init(width: frame.width, height: frame.height, scale: frame.scale, rotation: frame.rotation, viewSize: viewSize)
    }

    /// The upright picture's size in picture pixels.
    var uprightSize: CGSize { rotation.swapsSides ? CGSize(width: height, height: width) : CGSize(width: width, height: height) }

    /// The upright picture's rectangle in the view: as large as fits, centred.
    var frame: CGRect {
        let upright = uprightSize
        guard upright.width > 0, upright.height > 0, viewSize.width > 0, viewSize.height > 0 else { return .zero }
        let fit = min(viewSize.width / upright.width, viewSize.height / upright.height)
        let size = CGSize(width: upright.width * fit, height: upright.height * fit)
        return CGRect(x: (viewSize.width - size.width) / 2, y: (viewSize.height - size.height) / 2, width: size.width, height: size.height)
    }

    /// Picture pixels to view points. A layer whose bounds are the picture's pixels, anchored and
    /// positioned at its top-left corner (0, 0), draws upright and fitted with this transform.
    var transform: CGAffineTransform {
        let fitted = frame
        guard fitted.width > 0 else { return .identity }
        let turn: CGAffineTransform = switch rotation {
        case .none: .identity
        case .quarter: CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: height, ty: 0)
        case .half: CGAffineTransform(a: -1, b: 0, c: 0, d: -1, tx: width, ty: height)
        case .threeQuarters: CGAffineTransform(a: 0, b: -1, c: 1, d: 0, tx: 0, ty: width)
        }
        let zoom = fitted.width / uprightSize.width
        return turn.concatenating(CGAffineTransform(scaleX: zoom, y: zoom)).concatenating(CGAffineTransform(translationX: fitted.minX, y: fitted.minY))
    }

    /// The picture pixel under a point in the view; nil outside the picture.
    func picturePixel(at point: CGPoint) -> CGPoint? {
        guard frame.width > 0 else { return nil }
        let pixel = point.applying(transform.inverted())
        // Rounding in the inverse may leave an edge a hair outside.
        let slack = 1e-6
        guard pixel.x >= -slack, pixel.y >= -slack, pixel.x <= width + slack, pixel.y <= height + slack else { return nil }
        return CGPoint(x: min(max(pixel.x, 0), width), y: min(max(pixel.y, 0), height))
    }

    /// The device point under a point in the view, as device input takes it; nil outside the picture.
    func devicePoint(at point: CGPoint) -> CGPoint? {
        guard scale > 0, let pixel = picturePixel(at: point) else { return nil }
        return CGPoint(x: pixel.x / scale, y: pixel.y / scale)
    }
}
