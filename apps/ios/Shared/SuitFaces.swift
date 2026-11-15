import Observation

/// The font faces the Suit on screen draws with (ADR 0150), by slot: UI, the transcript's prose
/// and code. Each is a face this phone can load (a bundled file the app registered, or an
/// installed family); nil leaves SF Pro or SF Mono. The app sets them; widgets never do and
/// keep the system fonts. Reading a face from a view's body redraws it when the Suit changes.
@MainActor @Observable final class SuitFaces {
    static let shared = SuitFaces()
    private(set) var ui: String?
    private(set) var prose: String?
    private(set) var mono: String?

    func wear(ui: String?, prose: String?, mono: String?) {
        if self.ui != ui { self.ui = ui }
        if self.prose != prose { self.prose = prose }
        if self.mono != mono { self.mono = mono }
    }

    /// Code takes the mono face; the transcript its prose face, else the UI face; the rest UI.
    func face(monospaced: Bool, prose inProse: Bool) -> String? {
        if monospaced { return mono }
        return inProse ? (prose ?? ui) : ui
    }
}
