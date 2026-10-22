import AppKit
import ApplicationServices

/// Scrolling by element (accessibility first, which works on covered and off-screen windows)
/// or at a screenshot point (a real wheel event there, which scrolls whatever is under it;
/// addressed to the window when it is on another Space or behind a full-screen app).
extension CUActor {
    func scroll(_ action: CUObject) async throws -> String {
        let direction = action.string("direction") ?? "down"
        guard ["up", "down", "left", "right"].contains(direction) else { throw CUError("bad_action", "direction is up, down, left or right.") }
        let pages = action.double("pages"), pixels = action.double("pixels")
        if pages != nil && pixels != nil { throw CUError("bad_action", "scroll takes pages or pixels, not both.") }
        let lands = pointerDelivery != .unavailable
        var start: AXUIElement?
        var point: CGPoint?
        if action.int("id") != nil { start = try element(action) }
        else if let x = action.double("x"), let y = action.double("y") {
            let at = try session.screenPoint(fromPixel: CGPoint(x: x, y: y))
            point = at
            // A wheel event at the point is exact; in a minimized window, scroll what is there.
            if !lands { start = hitElement(at: at) }
        } else if let first = session.lastNodes.first(where: { $0.axRole == "AXScrollArea" || $0.axRole == "AXWebArea" }) {
            start = session.registry.element(first.id)
        }
        if point == nil || !lands, let start, let done = try await scrollThroughAccessibility(from: start, direction: direction, pages: pages, pixels: pixels) {
            return done
        }
        guard lands, let at = point ?? start.flatMap(visibleCenter) ?? session.window.map({ CGPoint(x: $0.frame.midX, y: $0.frame.midY) }) else {
            throw CUError("not_scrollable", "Found nothing scrollable there, and the window is minimized or hidden, so a wheel event would not land. Pass the id of a scroll area or list, or use keys such as PageDown.")
        }
        let viewport = start.flatMap { scrollArea(containing: $0).flatMap(cuFrame(of:)) }?.size ?? session.window?.frame.size ?? CGSize(width: 800, height: 600)
        let distance = cuScrollDistance(direction: direction, pages: pages, pixels: pixels, viewport: viewport)
        try await wheel(at: at, deltas: cuWheelDeltas(direction: direction, distance: distance), over: start)
        return "scrolled \(direction) \(Int(distance)) points with the mouse wheel\(start.map { " over \(label($0))" } ?? "")"
    }

    private func wheel(at point: CGPoint, deltas: [CUWheelDelta], over element: AXUIElement?) async throws {
        if session.window?.onScreen == true, !cuScreenLocked() { indicate(point) }
        session.makeKey()
        let target = pointerDelivery == .windowTargeted ? pointerTarget(for: element ?? hitElement(at: point)) : nil
        for (index, delta) in deltas.enumerated() {
            if index > 0 { try await pause(ms: 16) }
            try checkpoint()
            poster.scroll(at: point, window: session.window?.number, target: target, delta: delta)
        }
        session.settler.markChanged()
    }

    /// Page actions, then scroll bar values, on the element or its nearest scrolling ancestor.
    private func scrollThroughAccessibility(from start: AXUIElement, direction: String, pages: Double?, pixels: Double?) async throws -> String? {
        let byPage = "AXScroll\(direction.prefix(1).uppercased() + direction.dropFirst())ByPage"
        var current: AXUIElement? = start
        for _ in 0..<8 {
            guard let element = current else { return nil }
            // Some areas list page actions they then refuse; fall back to their bars.
            if pixels == nil, let pages, pages >= 1, cuActionNames(element).contains(byPage),
               AXUIElementPerformAction(element, byPage as CFString) == .success {
                let count = max(1, Int(pages.rounded()))
                for _ in 1..<count {
                    try checkpoint()
                    AXUIElementPerformAction(element, byPage as CFString)
                }
                session.settler.markChanged()
                return "scrolled \(label(element)) \(direction) \(count) page(s)"
            }
            if cuRole(element) == "AXScrollArea", let visible = cuFrame(of: element) {
                let distance = cuScrollDistance(direction: direction, pages: pages, pixels: pixels, viewport: visible.size)
                let signed = direction == "down" || direction == "right" ? distance : -distance
                let vertical = direction == "up" || direction == "down"
                if let percent = moveScrollBar(element, by: vertical ? CGVector(dx: 0, dy: signed) : CGVector(dx: signed, dy: 0)) {
                    return "scrolled \(label(element)) \(direction) to \(percent)%"
                }
                if let content = (cuAttribute(element, "AXContents") as? [AXUIElement])?.first.flatMap(cuFrame(of:)),
                   vertical ? content.height <= visible.height + 1 : content.width <= visible.width + 1 {
                    // A scrolling box inside a web page has no scroll bars in accessibility;
                    // only the page's own area is seen here. Let a wheel event at it decide.
                    if !CFEqual(element, start), pointerDelivery != .unavailable, insideWebArea(start) { return nil }
                    return "\(label(element)) already shows all its content; nothing to scroll \(direction)"
                }
            }
            current = parent(element)
        }
        return nil
    }

    /// Moves a scroll area's bars by a content offset in points. Returns the new position in
    /// percent, or nil when the area has no settable bar or no known content size.
    private func moveScrollBar(_ area: AXUIElement, by offset: CGVector) -> Int? {
        guard let visible = cuFrame(of: area), let content = (cuAttribute(area, "AXContents") as? [AXUIElement])?.first.flatMap(cuFrame(of:)) else { return nil }
        var percent: Int?
        for (vertical, amount) in [(true, offset.dy), (false, offset.dx)] where amount != 0 {
            let total = vertical ? content.height - visible.height : content.width - visible.width
            guard total > 0, let bar = cuAttribute(area, vertical ? "AXVerticalScrollBar" : "AXHorizontalScrollBar").map({ $0 as! AXUIElement }),
                  let value = (cuAttribute(bar, "AXValue") as? NSNumber)?.doubleValue else { return nil }
            let next = min(1, max(0, value + Double(amount / total)))
            guard AXUIElementSetAttributeValue(bar, "AXValue" as CFString, next as CFNumber) == .success else { return nil }
            percent = Int((next * 100).rounded())
        }
        if percent != nil { session.settler.markChanged() }
        return percent
    }

    private func insideWebArea(_ element: AXUIElement) -> Bool {
        var current: AXUIElement? = element
        for _ in 0..<16 {
            guard let item = current else { return false }
            if cuRole(item) == "AXWebArea" { return true }
            current = parent(item)
        }
        return false
    }

    func scrollArea(containing element: AXUIElement) -> AXUIElement? {
        var current: AXUIElement? = element
        for _ in 0..<12 {
            guard let item = current else { return nil }
            if cuRole(item) == "AXScrollArea" { return item }
            current = parent(item)
        }
        return nil
    }

    /// Brings an element into view: AXScrollToVisible when offered, else scrolls each enclosing
    /// scroll area until the element's frame is inside its visible rect.
    func scrollTo(_ action: CUObject) async throws -> String {
        let target = try element(action)
        if cuActionNames(target).contains("AXScrollToVisible") {
            let note = try await perform(target, "AXScrollToVisible")
            return "scrolled \(label(target)) into view\(note)"
        }
        for _ in 0..<6 {
            try checkpoint()
            guard let frame = cuFrame(of: target) else { break }
            var area = parent(target).flatMap(scrollArea(containing:))
            var moved = false
            while let current = area, !moved {
                if let visible = cuFrame(of: current) {
                    let offset = cuRevealOffset(element: frame, visible: visible)
                    if offset.dx != 0 || offset.dy != 0 {
                        if moveScrollBar(current, by: offset) == nil {
                            guard pointerDelivery != .unavailable else {
                                throw CUError("not_scrollable", "\(label(target)) is outside its scroll area, which can't be scrolled through accessibility while the window is minimized or hidden. Try keys such as PageDown.")
                            }
                            let deltas = cuWheelDeltas(direction: offset.dy > 0 ? "down" : offset.dy < 0 ? "up" : offset.dx > 0 ? "right" : "left",
                                                       distance: Double(abs(offset.dy != 0 ? offset.dy : offset.dx)))
                            try await wheel(at: CGPoint(x: visible.midX, y: visible.midY), deltas: deltas, over: current)
                        }
                        moved = true
                    }
                }
                area = parent(current).flatMap(scrollArea(containing:))
            }
            if !moved { return "scrolled \(label(target)) into view" }
            try await pause(ms: 50)
        }
        throw CUError("not_scrollable", "Could not bring \(label(target)) into view. Scroll its list with scroll, or use keys.")
    }
}
