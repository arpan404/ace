import CoreGraphics
import Foundation

/// One touch point as the page gets it: CSS pixels and a slot id (0–9) stable while the finger is down.
struct RemoteTouchPoint: Equatable, Sendable { let x: Double; let y: Double; let id: Int }

/// The person's input as the protocol's `BrowserInput` carries it (`browser.input`).
enum RemoteInput: Equatable, Sendable {
    case touch(event: String, points: [RemoteTouchPoint])
    case key(event: String, key: String, code: String? = nil, text: String? = nil)
    /// IME text being composed, shown marked at the page's caret; empty cancels it.
    case ime(text: String, selectionStart: Int, selectionEnd: Int)
    /// The person's choice in the page's open picker; nil values dismiss it.
    case pick(pickerId: String, values: [String]?)

    var json: [String: Any] {
        switch self {
        case .touch(let event, let points):
            return ["kind": "touch", "event": event, "points": points.map { ["x": $0.x, "y": $0.y, "id": $0.id] }]
        case .key(let event, let key, let code, let text):
            var value: [String: Any] = ["kind": "key", "event": event, "key": key]
            if let code { value["code"] = code }
            if let text { value["text"] = text }
            return value
        case .ime(let text, let start, let end):
            return ["kind": "ime", "text": text, "selectionStart": start, "selectionEnd": end]
        case .pick(let pickerId, let values):
            var value: [String: Any] = ["kind": "pick", "pickerId": pickerId]
            if let values { value["values"] = values }
            return value
        }
    }
}

/// Where the picture sits in the view and how points map between the view and the page's CSS
/// pixels. The page's width fits the view (never drawn larger than 1:1), from the top, as a phone's
/// browser shows a page; a picture larger than the view (a desktop, or a phone taller than the
/// view) can be zoomed and moved by the person. Pure, so the mapping is tested directly.
struct PageGeometry: Equatable {
    /// The view's size in points.
    let view: CGSize
    /// The page's size in CSS pixels, as the latest picture reports it.
    let page: CGSize
    /// The person's zoom on top of the fit, 1 to `maxZoom`.
    var zoom: CGFloat = 1
    /// The picture's top-left corner as the person moved it, in view points; kept inside `box`'s limits.
    var offset: CGPoint = .zero

    static let maxZoom: CGFloat = 4

    /// The scale the picture is drawn at before the person's zoom.
    var fitScale: CGFloat {
        guard view.width > 0, page.width > 0 else { return 1 }
        return min(1, view.width / page.width)
    }
    /// The picture's box in the view: centred across while it is narrower, at the top while it is
    /// shorter, and otherwise where the person moved it, never leaving a gap at an edge.
    var box: CGRect {
        guard view.width > 0, view.height > 0, page.width > 0, page.height > 0 else { return .zero }
        let scale = fitScale * zoom
        let size = CGSize(width: page.width * scale, height: page.height * scale)
        let x = size.width <= view.width ? (view.width - size.width) / 2 : min(0, max(view.width - size.width, offset.x))
        let y = size.height <= view.height ? 0 : min(0, max(view.height - size.height, offset.y))
        return CGRect(x: x, y: y, width: size.width, height: size.height)
    }
    /// The picture is larger than the view, or zoomed: two fingers move and zoom it instead of
    /// going to the page.
    var movable: Bool {
        let box = box
        return zoom > 1 || box.width > view.width + 0.5 || box.height > view.height + 0.5
    }
    /// Moved by a two-finger drag of `delta` view points.
    func panned(by delta: CGPoint) -> PageGeometry {
        var next = self
        let origin = box.origin
        next.offset = CGPoint(x: origin.x + delta.x, y: origin.y + delta.y)
        return next.settled()
    }
    /// Zoomed by `factor` around a view point, which stays over the same place in the page.
    func zoomed(by factor: CGFloat, around focus: CGPoint) -> PageGeometry {
        var next = self
        next.zoom = min(Self.maxZoom, max(1, zoom * factor))
        let ratio = next.zoom / zoom
        let origin = box.origin
        next.offset = CGPoint(x: focus.x - (focus.x - origin.x) * ratio, y: focus.y - (focus.y - origin.y) * ratio)
        return next.settled()
    }
    /// The offset where the box actually is, so a later move starts from what is shown.
    private func settled() -> PageGeometry {
        var next = self
        next.offset = box.origin
        return next
    }
    /// A view point in the page, clamped to its edges (a finger that slides off keeps its edge).
    func pagePoint(_ point: CGPoint) -> CGPoint {
        let box = box
        guard box.width > 0, box.height > 0 else { return .zero }
        let x = (point.x - box.minX) / box.width * page.width
        let y = (point.y - box.minY) / box.height * page.height
        return CGPoint(x: min(max(x, 0), page.width), y: min(max(y, 0), page.height))
    }
    /// A box of the page (a focused field, a picker) in view points.
    func viewRect(_ rect: PageRect) -> CGRect {
        let box = box
        guard page.width > 0, page.height > 0 else { return .zero }
        let scale = box.width / page.width
        return CGRect(x: box.minX + rect.x * scale, y: box.minY + rect.y * scale, width: rect.width * scale, height: rect.height * scale)
    }
}

/// One touch sequence, from the first finger down to the last one up. Every active finger goes
/// to the page as a touch point, so the page's own gestures make a tap's click, a drag's scroll
/// and a pinch's zoom, as on a phone's browser. `Key` identifies a finger (a `UITouch`'s identity).
struct TouchTracker<Key: Hashable> {
    /// The page takes up to ten touch points.
    static var limit: Int { 10 }
    private var fingers: [Key: RemoteTouchPoint] = [:]

    var active: Int { fingers.count }

    /// Fingers touched down at these page points.
    mutating func began(_ touches: [(Key, CGPoint)]) -> RemoteInput? {
        var added = false
        for (key, point) in touches where fingers[key] == nil {
            guard let slot = freeSlot() else { break }
            fingers[key] = RemoteTouchPoint(x: point.x, y: point.y, id: slot)
            added = true
        }
        return added ? .touch(event: "touchStart", points: points) : nil
    }
    /// Fingers moved. Unknown ones (down before the view took input, or past the limit) are ignored.
    mutating func moved(_ touches: [(Key, CGPoint)]) -> RemoteInput? {
        var changed = false
        for (key, point) in touches {
            guard let finger = fingers[key], finger.x != point.x || finger.y != point.y else { continue }
            fingers[key] = RemoteTouchPoint(x: point.x, y: point.y, id: finger.id)
            changed = true
        }
        return changed ? .touch(event: "touchMove", points: points) : nil
    }
    /// Fingers lifted. The page sees one leave as a move without it; the last one up ends the sequence.
    mutating func ended(_ keys: [Key]) -> RemoteInput? {
        let before = fingers.count
        for key in keys { fingers[key] = nil }
        if fingers.count == before { return nil }
        return fingers.isEmpty ? .touch(event: "touchEnd", points: []) : .touch(event: "touchMove", points: points)
    }
    /// The system took the touches back (a system gesture, an alert).
    mutating func cancelled() -> RemoteInput? {
        guard !fingers.isEmpty else { return nil }
        fingers.removeAll()
        return .touch(event: "touchCancel", points: [])
    }

    private var points: [RemoteTouchPoint] { fingers.values.sorted { $0.id < $1.id } }
    private func freeSlot() -> Int? {
        let used = Set(fingers.values.map(\.id))
        return (0..<Self.limit).first { !used.contains($0) }
    }
}
