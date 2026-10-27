import CoreGraphics

/// One finger (or the Pencil) on the page in annotate mode (ADR 0082), as the page's overlay
/// wants it: a tap is a click, which pins the element under it; a drag is a press, moves and a
/// release, which outline an area. Nothing reaches the page until the finger either lifts (a
/// tap) or travels far enough to be a drag, so a second finger landing early (a two-finger
/// scroll or zoom) sends nothing. Pure: points in, inputs out, so the rules are tested directly.
struct AnnotateStroke {
    /// View points a finger travels before a press becomes a drag; the overlay's own threshold is
    /// 4 CSS pixels, so a drag always reaches it.
    static let dragDistance: CGFloat = 8

    private var start: (view: CGPoint, page: CGPoint)?
    private var dragging = false
    private var last: CGPoint = .zero
    /// The stroke was given up (a second finger): nothing more until every finger lifts.
    private var abandoned = false

    /// A finger touched down at `view` (view points), which is `page` in CSS pixels.
    mutating func began(view: CGPoint, page: CGPoint, fingers: Int) -> [RemoteInput] {
        if fingers > 1 || start != nil { return abandon() }
        abandoned = false
        start = (view, page)
        last = page
        dragging = false
        return []
    }
    mutating func moved(view: CGPoint, page: CGPoint) -> [RemoteInput] {
        guard let start, !abandoned else { return [] }
        last = page
        if dragging { return [.mouse(event: "mouseMoved", x: page.x, y: page.y, held: true)] }
        guard hypot(view.x - start.view.x, view.y - start.view.y) >= Self.dragDistance else { return [] }
        dragging = true
        return [
            .mouse(event: "mouseMoved", x: start.page.x, y: start.page.y, held: false),
            .mouse(event: "mousePressed", x: start.page.x, y: start.page.y, held: true),
            .mouse(event: "mouseMoved", x: page.x, y: page.y, held: true),
        ]
    }
    /// The finger lifted: a tap clicks where it touched; a drag releases where it ended.
    mutating func ended() -> [RemoteInput] {
        defer { reset() }
        guard let start, !abandoned else { return [] }
        if dragging { return [.mouse(event: "mouseReleased", x: last.x, y: last.y, held: false)] }
        return [
            .mouse(event: "mouseMoved", x: start.page.x, y: start.page.y, held: false),
            .mouse(event: "mousePressed", x: start.page.x, y: start.page.y, held: true),
            .mouse(event: "mouseReleased", x: start.page.x, y: start.page.y, held: false),
        ]
    }
    /// The system took the touch back: a drag under way is let go where it is.
    mutating func cancelled() -> [RemoteInput] {
        defer { reset() }
        guard start != nil, dragging, !abandoned else { return [] }
        return [.mouse(event: "mouseReleased", x: last.x, y: last.y, held: false)]
    }
    /// A second finger: a drag under way ends where it is, a press not yet sent never is.
    private mutating func abandon() -> [RemoteInput] {
        let release: [RemoteInput] = dragging && !abandoned ? [.mouse(event: "mouseReleased", x: last.x, y: last.y, held: false)] : []
        abandoned = true
        return release
    }
    private mutating func reset() {
        start = nil
        dragging = false
        abandoned = false
    }
}
