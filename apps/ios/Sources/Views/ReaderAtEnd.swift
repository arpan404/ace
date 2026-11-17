import SwiftUI

/// Tells the bridge whether the reader sits at the transcript's live end while the app is in
/// front, so staying at the last answer marks the thread read (`thread-read-mark.ts`) and the
/// row's finished-result check goes, as on the desktop. Sent again under each navigation
/// generation: a thread reopened from its machine has a new session that starts not at the end.
struct ReaderAtEnd: ViewModifier {
    @Environment(\.scenePhase) private var scenePhase
    let model: ClientModel
    let thread: ThreadModel
    let atEnd: Bool

    private struct Place: Equatable {
        let epoch: Int
        let atEnd: Bool
    }

    func body(content: Content) -> some View {
        content.onChange(of: Place(epoch: thread.epoch, atEnd: atEnd && scenePhase == .active), initial: true) { _, place in
            model.readerAtEnd(place.atEnd, epoch: place.epoch)
        }
    }
}
