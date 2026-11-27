import AVFAudio
import Foundation

/// The app's one audio session, shared by dictation, Spade's voice messages and the live browser's
/// page sound. Each claims it while it records or plays and releases it when done; who sets it up
/// and when it goes inactive is `AudioSessionClaims`. Safe from any thread.
final class AppAudioSession: @unchecked Sendable {
    /// The system's session is one per app, so this is too.
    static let shared = AppAudioSession()
    struct Claim: Hashable, Sendable { fileprivate let id: Int }

    private let lock = NSLock()
    private var claims = AudioSessionClaims()
    private var count = 0

    /// Holds the session for `setup`. Throws when it wins and the session can't be set up so; the
    /// claim is then let go.
    func claim(_ setup: AudioSessionSetup) throws -> Claim {
        try lock.withLock {
            count += 1
            let claim = Claim(id: count)
            do { try apply(claims.claim(claim.id, setup)) } catch {
                _ = claims.release(claim.id)
                throw error
            }
            return claim
        }
    }
    func release(_ claim: Claim?) {
        guard let claim else { return }
        lock.withLock { try? apply(claims.release(claim.id)) }
    }
    /// The category kept while nobody holds the session (picture-in-picture needs `.playback`).
    func setIdle(_ setup: AudioSessionSetup) {
        lock.withLock { try? apply(claims.setIdle(setup)) }
    }

    private func apply(_ step: AudioSessionClaims.Apply) throws {
        let session = AVAudioSession.sharedInstance()
        switch step {
        case .activate(let setup):
            try configure(session, setup)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        case .deactivate(let idle):
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            if let idle { try? configure(session, idle) }
        case .category(let setup): try configure(session, setup)
        case .none: break
        }
    }
    private func configure(_ session: AVAudioSession, _ setup: AudioSessionSetup) throws {
        try session.setCategory(AVAudioSession.Category(rawValue: setup.category), mode: AVAudioSession.Mode(rawValue: setup.mode),
                                options: AVAudioSession.CategoryOptions(rawValue: setup.options))
    }
}
