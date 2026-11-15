import Foundation

/// The I/O around `PasteIntake`: stages each long paste off the main actor, then attaches what
/// the intake releases, in paste order, to the thread it was pasted in, and discards the staged
/// copy of one whose thread closed meanwhile. Held by the thread screen; a staging task keeps it
/// alive past the screen, so a paste still finishes (or is discarded) after the person leaves.
@MainActor @Observable final class PasteQueue {
    private(set) var intake = PasteIntake()
    private let staging: AttachmentStaging
    init(staging: AttachmentStaging = AttachmentStaging()) { self.staging = staging }

    /// `words` pasted into thread `scope`'s composer. `open` says which thread is open when the
    /// write finishes; `attach` puts a file on that thread's next message; `refused` says why one can't go.
    func paste(_ words: String, scope: String, open: @escaping @MainActor () -> String?,
               attach: @escaping @MainActor (StagedAttachment) -> Void, refused: @escaping @MainActor (String) -> Void) {
        let ticket = intake.began(scope: scope, name: "Paste")
        let staging = staging
        Task {
            var file: StagedAttachment?
            switch await ComposerIntake.stage(paste: words, into: staging) {
            case .file(let staged): file = staged
            case .refused(let why): refused(why)
            case .words: break
            }
            let release = intake.finished(ticket, file: file, open: open())
            for gone in release.discard { staging.discard(gone.localId) }
            for staged in release.attach { attach(staged) }
        }
    }
}
