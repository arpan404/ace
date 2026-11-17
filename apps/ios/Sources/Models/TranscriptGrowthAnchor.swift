/// Which edge of the transcript holds still when its content changes size.
///
/// A lazy stack guesses the heights of the rows it hasn't laid out, and corrects them as rows
/// measure. By default the scroll view keeps its offset from the top, so every correction above
/// the screen moves the rows on it: a long thread opened at its end first draws short of the end
/// and then jumps there. Holding the bottom still instead keeps what is on screen where it is.
///
/// The bottom holds only while nothing but those corrections changes the size: from a thread
/// opening at its end until its rows have settled, the reader first moves it, or the feed leaves
/// the end. Anything the reader opens, a keyboard and older pages grow under a held top, as
/// before. Pure.
struct TranscriptGrowthAnchor: Equatable, Sendable {
    private var opening = false

    /// Size changes keep the bottom edge where it is.
    var keepsEnd: Bool { opening }

    /// The feed appeared or its rows first laid out; `atEnd` when it opened following the live end.
    mutating func opened(atEnd: Bool) {
        if atEnd { opening = true }
    }

    /// The opened rows have measured: size changes keep the top again.
    mutating func openSettled() { opening = false }

    /// The feed stopped following the end without the reader's hand (a jump, a turn key).
    mutating func leftEnd() { opening = false }

    /// The reader moved the feed or changed what it holds: a drag, a disclosure, the keyboard.
    mutating func readerMoved() { opening = false }
}
