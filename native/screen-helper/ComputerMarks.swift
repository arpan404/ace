import AppKit

/// Where to draw an id tag, in image pixels.
struct CUMark: Equatable {
    let id: Int
    let rect: CGRect
}

/// Elements worth tagging: ones that act, are a reasonable size and sit inside the window.
/// Pure, so placement is tested without drawing.
func cuMarks(nodes: [CUNode], window: CGRect, scale: Double) -> [CUMark] {
    let windowArea = window.width * window.height
    var marks: [CUMark] = []
    for node in nodes {
        guard let frame = node.frame, frame.width >= 6, frame.height >= 6 else { continue }
        let acts = node.axActions.contains("AXPress") || cuTextInputRoles.contains(node.axRole)
            || ["AXRow", "AXCell", "AXOutlineRow", "AXLink", "AXTab", "AXSlider", "AXPopUpButton", "AXMenuButton", "AXCheckBox", "AXRadioButton"].contains(node.axRole)
        guard acts, node.axRole != "AXWindow", frame.width * frame.height < windowArea * 0.4 else { continue }
        let local = frame.offsetBy(dx: -window.minX, dy: -window.minY).intersection(CGRect(origin: .zero, size: window.size))
        guard !local.isNull, local.width >= 4, local.height >= 4 else { continue }
        marks.append(CUMark(id: node.id, rect: CGRect(x: local.minX * scale, y: local.minY * scale, width: local.width * scale, height: local.height * scale)))
        if marks.count >= 300 { break }
    }
    return marks
}

/// Draws a thin outline and an id tag on each mark. Image coordinates are top-left based.
func cuDrawMarks(_ image: CGImage, marks: [CUMark]) -> CGImage {
    guard !marks.isEmpty, let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
                                                    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue) else { return image }
    let height = CGFloat(image.height)
    context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    let graphics = NSGraphicsContext(cgContext: context, flipped: false)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = graphics
    let accent = NSColor(calibratedRed: 1.0, green: 0.22, blue: 0.55, alpha: 1)
    let font = NSFont.monospacedDigitSystemFont(ofSize: max(10, min(13, CGFloat(image.width) / 110)), weight: .bold)
    for mark in marks {
        // Flip from top-left image space into the context's bottom-left space.
        let box = CGRect(x: mark.rect.minX, y: height - mark.rect.maxY, width: mark.rect.width, height: mark.rect.height)
        context.setStrokeColor(accent.withAlphaComponent(0.85).cgColor)
        context.setLineWidth(1.5)
        context.stroke(box.insetBy(dx: 0.75, dy: 0.75))
        let label = NSAttributedString(string: "\(mark.id)", attributes: [.font: font, .foregroundColor: NSColor.white])
        let size = label.size()
        let tag = CGRect(x: box.minX, y: min(box.maxY, height) - size.height - 2, width: size.width + 6, height: size.height + 2)
        context.setFillColor(accent.cgColor)
        context.fill(tag)
        label.draw(at: CGPoint(x: tag.minX + 3, y: tag.minY + 1))
    }
    NSGraphicsContext.restoreGraphicsState()
    return context.makeImage() ?? image
}
