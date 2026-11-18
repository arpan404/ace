import Foundation

/// The camera permission as the scanner needs it, read from AVFoundation by `CameraProbe`.
enum CameraAccess: Equatable, Sendable { case allowed, undecided, denied, restricted }

/// What the pairing scanner shows. Every way it can't scan is a state of its own on screen, so a
/// phone with no camera (the simulator) or with access off never closes the scanner silently.
enum ScannerPhase: Equatable {
    /// Waiting on the system's camera prompt.
    case asking
    case scanning
    /// The person turned camera access off.
    case denied
    /// Screen Time or a profile keeps the camera off.
    case restricted
    case noCamera
    /// A pairing link, read once and on its way back to the pairing page.
    case found(String)
}

/// The scanner's decisions, free of AVFoundation: permission, a camera that's missing or won't
/// start, and which code the camera saw is the one handed back.
struct ScannerModel: Equatable {
    enum Reading: Equatable {
        /// The pairing link: hand it back.
        case accepted
        /// A code that isn't one; `note` says why.
        case rejected
        /// Nothing new: not scanning, or the same code read again on the next frame.
        case ignored
    }

    private(set) var phase: ScannerPhase
    /// Why the last code read wasn't taken, shown in place of the instruction.
    private(set) var note: String?
    private var rejected: String?

    init(access: CameraAccess, hasCamera: Bool) {
        guard hasCamera else { phase = .noCamera; return }
        switch access {
        case .allowed: phase = .scanning
        case .undecided: phase = .asking
        case .denied: phase = .denied
        case .restricted: phase = .restricted
        }
    }

    var showsCamera: Bool {
        switch phase {
        case .asking, .scanning, .found: true
        case .denied, .restricted, .noCamera: false
        }
    }
    var offersSettings: Bool { phase == .denied || phase == .restricted }

    /// The answer to the system's camera prompt.
    mutating func answered(granted: Bool) {
        guard phase == .asking else { return }
        phase = granted ? .scanning : .denied
    }

    /// The camera couldn't be opened after all.
    mutating func cameraFailed() {
        if phase == .asking || phase == .scanning { phase = .noCamera }
    }

    /// A code the camera read, with why it can't pair (nil when it can).
    mutating func read(_ code: String, problem: String?) -> Reading {
        guard phase == .scanning, code != rejected else { return .ignored }
        if let problem {
            rejected = code
            note = problem
            return .rejected
        }
        note = nil
        phase = .found(code)
        return .accepted
    }
}
