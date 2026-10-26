import SwiftUI
import UIKit

/// Where an image sits on screen at rest: as large as fits `bounds`, keeping its shape, whatever
/// its own pixel size (a small image grows to fit, a large one shrinks).
enum MediaFit {
    static func fitted(_ image: CGSize, in bounds: CGSize) -> CGSize {
        guard image.width > 0, image.height > 0, bounds.width > 0, bounds.height > 0 else { return .zero }
        let scale = min(bounds.width / image.width, bounds.height / image.height)
        return CGSize(width: image.width * scale, height: image.height * scale)
    }
    /// How far a pinch or double tap can zoom past the fitted size.
    static let maximumZoom: CGFloat = 4
    /// Where a double tap zooms to.
    static let doubleTapZoom: CGFloat = 2.5
}

/// An image fitted to the screen that pinches to zoom (fitted to 4×), pans while zoomed, toggles
/// zoom on a double tap and springs back inside its bounds. With `dismiss`, dragging it down at
/// the fitted size closes the viewer.
struct ZoomableImage: UIViewRepresentable {
    let image: UIImage
    let label: String
    var dismiss: (() -> Void)? = nil
    func makeUIView(context: Context) -> ZoomingImageView {
        let view = ZoomingImageView(image: image)
        view.imageView.accessibilityLabel = label
        view.dismiss = dismiss
        return view
    }
    func updateUIView(_ view: ZoomingImageView, context: Context) {
        view.imageView.accessibilityLabel = label
        view.dismiss = dismiss
        if view.imageView.image !== image { view.show(image) }
    }
}

final class ZoomingImageView: UIScrollView, UIScrollViewDelegate, UIGestureRecognizerDelegate {
    let imageView = UIImageView()
    var dismiss: (() -> Void)?
    private var fittedFor: CGSize = .zero
    private let pull = UIPanGestureRecognizer()

    init(image: UIImage) {
        super.init(frame: .zero)
        delegate = self
        showsHorizontalScrollIndicator = false
        showsVerticalScrollIndicator = false
        contentInsetAdjustmentBehavior = .never
        decelerationRate = .fast
        bouncesZoom = true
        minimumZoomScale = 1
        maximumZoomScale = MediaFit.maximumZoom
        backgroundColor = .clear
        imageView.contentMode = .scaleAspectFit
        imageView.isAccessibilityElement = true
        imageView.accessibilityTraits = .image
        imageView.accessibilityIdentifier = "media.image"
        addSubview(imageView)
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(toggleZoom(_:)))
        doubleTap.numberOfTapsRequired = 2
        addGestureRecognizer(doubleTap)
        pull.addTarget(self, action: #selector(pulled(_:)))
        pull.delegate = self
        addGestureRecognizer(pull)
        show(image)
    }
    required init?(coder: NSCoder) { nil }

    func show(_ image: UIImage) {
        imageView.image = image
        fittedFor = .zero
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if bounds.size != fittedFor { refit() }
        centre()
    }

    /// Back to the fitted size for the current bounds (first layout, rotation, a new image).
    private func refit() {
        fittedFor = bounds.size
        zoomScale = minimumZoomScale
        let size = MediaFit.fitted(imageView.image?.size ?? .zero, in: bounds.size)
        imageView.frame = CGRect(origin: .zero, size: size)
        contentSize = size
        describeZoom()
    }

    /// Keeps the image centred while it is smaller than the screen on either side.
    private func centre() {
        let horizontal = max(0, (bounds.width - contentSize.width) / 2)
        let vertical = max(0, (bounds.height - contentSize.height) / 2)
        let insets = UIEdgeInsets(top: vertical, left: horizontal, bottom: vertical, right: horizontal)
        if contentInset != insets { contentInset = insets }
    }

    private func describeZoom() {
        imageView.accessibilityValue = "\(Int((zoomScale * 100).rounded()))%"
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }
    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        centre()
        describeZoom()
    }

    @objc private func toggleZoom(_ tap: UITapGestureRecognizer) {
        if zoomScale > minimumZoomScale + 0.01 {
            setZoomScale(minimumZoomScale, animated: true)
            return
        }
        let point = tap.location(in: imageView)
        let size = CGSize(width: bounds.width / MediaFit.doubleTapZoom, height: bounds.height / MediaFit.doubleTapZoom)
        zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
    }

    /// Dragging down at the fitted size moves the image with the finger; far or fast enough closes.
    @objc private func pulled(_ pan: UIPanGestureRecognizer) {
        let drop = max(0, pan.translation(in: self).y)
        switch pan.state {
        case .changed:
            imageView.transform = CGAffineTransform(translationX: 0, y: drop)
            alpha = 1 - min(0.5, drop / 600)
        case .ended where drop > 120 || pan.velocity(in: self).y > 900:
            dismiss?()
        case .ended, .cancelled, .failed:
            UIView.animate(withDuration: 0.3, delay: 0, usingSpringWithDamping: 0.85, initialSpringVelocity: 0) {
                self.imageView.transform = .identity
                self.alpha = 1
            }
        default: break
        }
    }

    override func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
        guard recognizer === pull else { return super.gestureRecognizerShouldBegin(recognizer) }
        let velocity = pull.velocity(in: self)
        return dismiss != nil && zoomScale <= minimumZoomScale + 0.01 && velocity.y > abs(velocity.x)
    }
    func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        recognizer === pull && other === panGestureRecognizer
    }
}
