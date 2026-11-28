import Foundation

/// The speaker at the end of the browser's address, as a browser shows it (ADR 0088 › Audio). Pure.
///
/// It shows only while the page plays sound or its tab is muted, and says what the person hears:
/// - The tab is muted (for everyone): crossed out; a tap unmutes it, and turns sound on on this
///   phone too when it is off here.
/// - The page plays but this phone has its sound off: crossed out; a tap turns it on here.
/// - Otherwise the person hears it: a tap mutes the tab.
struct BrowserSound: Equatable {
    enum Step: Equatable {
        case muteTab
        case unmuteTab(hereToo: Bool)
        case playHere
    }
    /// Drawn crossed out.
    let muted: Bool
    let label: String
    let step: Step

    /// The speaker for the shown tab, or nil when it has none. `here` is this phone's choice for the
    /// live view; nil where the phone can't play the page's sound.
    static func control(shown: BrowserViewInfo.Shown?, here: Bool?) -> BrowserSound? {
        if shown?.muted == true {
            return BrowserSound(muted: true, label: "Unmute tab", step: .unmuteTab(hereToo: here == false))
        }
        guard shown?.audible == true else { return nil }
        if here == false { return BrowserSound(muted: true, label: "Turn on sound", step: .playHere) }
        return BrowserSound(muted: false, label: "Mute tab", step: .muteTab)
    }

    /// Whether this phone's audio output is open: the person turned the sound on here, the view is
    /// open, and its shown tab plays and isn't muted. Anything else lets the audio session go.
    static func plays(here: Bool, open: Bool, shown: BrowserViewInfo.Shown?) -> Bool {
        here && open && shown?.audible == true && shown?.muted != true
    }
}
