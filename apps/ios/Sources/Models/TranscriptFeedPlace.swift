import CoreGraphics

/// The feed's place-keeping events routed between the place keeper and a focus landing. Pure:
/// the feed forwards every row layout, origin report, scroll phase, window revision, deadline
/// tick and takeover here, and performs the actions that come back.
///
/// The keeper (`TranscriptPlaceKeeper`) decides where the reader is held; it consults the
/// landing (`TranscriptFocusLanding`) through its facts, so nothing is captured or put back
/// while a focus lands. The landing is stepped whenever something could have brought its row
/// into view: its row laid out, the content scrolled (rows sit in content coordinates, so a
/// scroll moves only the origin), a scroll settling, the window's rows changing, or the reply
/// naming the target. Once shown, the keeper holds it. A landing that isn't active costs one
/// check per event.
enum TranscriptFeedPlace {
    enum Event: Equatable, Sendable {
        /// A row, origin, phase, jump or tick event for the keeper.
        case keeper(TranscriptPlaceKeeper.Event)
        /// The history window's rows changed.
        case revised
        /// A jump's reply named the item to bring into view.
        case targetNamed
        /// The landing's deadline came.
        case deadline
        /// The reader took the feed somewhere themselves.
        case takeover
    }

    enum Action: Equatable, Sendable {
        /// Hold `rowID`, `top` points below the header: the anchor to correct to and save.
        case hold(rowID: String, top: Double)
        /// Scroll so `rowID` sits `top` points below the header.
        case place(rowID: String, top: Double)
        /// Scroll to the landing focus's row, aligning `anchor` of it and of the scrolled space;
        /// nil centres it.
        case aim(rowID: String, anchor: Double?)
        /// The focus was shown, or let go without being shown: paging and the end's reads may run.
        case released
    }

    /// What the feed knows when an event arrives.
    struct Facts {
        /// What the feed allows the keeper; `focusLanding` is filled in from the landing.
        var keeper: TranscriptPlaceKeeper.Facts
        var geometry: TranscriptFocusLanding.Geometry
        /// The row now showing `item`, if any; asked only while a focus lands.
        var rowShowing: (String) -> String?
    }

    static func next(_ event: Event, keeper: inout TranscriptPlaceKeeper, landing: inout TranscriptFocusLanding,
                     facts: Facts, now: Double) -> [Action] {
        var actions: [Action] = []
        func forward(_ event: TranscriptPlaceKeeper.Event) {
            var allowed = facts.keeper
            allowed.focusLanding = landing.holdsPlace
            for action in keeper.next(event, facts: allowed, now: now) {
                switch action {
                case .hold(let id, let top): actions.append(.hold(rowID: id, top: top))
                case .place(let id, let top): actions.append(.place(rowID: id, top: top))
                }
            }
        }
        func step() {
            guard let target = landing.target else { return }
            let row = facts.rowShowing(target)
            let frame = row.flatMap { keeper.frames.frame($0) }
                .map { TranscriptFocusLanding.Span(top: Double($0.minY), bottom: Double($0.maxY)) }
            switch landing.step(row: row, frame: frame, in: facts.geometry, now: now) {
            case .scroll(let id, let anchor): actions.append(.aim(rowID: id, anchor: anchor))
            case .landed(let id):
                forward(.focusLanded(id))
                actions.append(.released)
            case .none: actions.append(.released)
            case .wait: break
            }
        }
        switch event {
        case .keeper(let event):
            let origin = keeper.frames.origin
            forward(event)
            guard landing.holdsPlace else { break }
            switch event {
            case .laidOut(let id, _):
                if keeper.lastLayout != .unchanged, let target = landing.target, facts.rowShowing(target) == id { step() }
            case .origin:
                if keeper.frames.origin != origin { step() }
            case .phase(.idle): step()
            default: break
            }
        case .revised, .targetNamed: step()
        case .deadline:
            let held = landing.holdsPlace
            landing.expire(now: now)
            if held, !landing.holdsPlace { actions.append(.released) }
        case .takeover:
            // Also with nothing landing: a failed open kept for Retry is the reader's to drop.
            landing.readerTookOver()
        }
        return actions
    }
}
