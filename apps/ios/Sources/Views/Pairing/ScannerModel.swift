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
    /// The camera was there but wouldn't start, or stopped with an error.
    case failed
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
    private var closed = false
    /// In the background, where the camera is stopped, until `recheck` on return.
    private(set) var backgrounded = false
    /// Which run of the camera is on screen. Each return from the background starts a new one,
    /// so a camera stopped there is never kept, however SwiftUI coalesces the updates.
    private(set) var cameraRun = 0

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
        case .denied, .restricted, .noCamera, .failed: false
        }
    }
    /// Whether the live camera should be running: scanning (or holding a taken code) and not
    /// in the background.
    var runsCamera: Bool { showsCamera && phase != .asking && !backgrounded }
    var offersSettings: Bool { phase == .denied || phase == .restricted }

    /// The answer to the system's camera prompt.
    mutating func answered(granted: Bool) {
        guard phase == .asking else { return }
        phase = granted ? .scanning : .denied
    }

    /// The camera couldn't be opened after all, or stopped with an error.
    mutating func cameraFailed() {
        if phase == .asking || phase == .scanning { phase = .failed }
    }

    /// Back in the foreground: the permission or camera may have changed meanwhile (access
    /// turned on in Settings), so every state but a taken code is decided again. A camera that
    /// failed gets another try.
    mutating func recheck(access: CameraAccess, hasCamera: Bool) {
        if backgrounded {
            backgrounded = false
            cameraRun += 1
        }
        if case .found = phase { return }
        guard !closed else { return }
        phase = ScannerModel(access: access, hasCamera: hasCamera).phase
    }

    /// The app went to the background, which stops the camera.
    mutating func enteredBackground() { backgrounded = true }

    /// The person closed the scanner: a code still showing its check is not handed back.
    mutating func close() { closed = true }

    /// Whether `code` may still go back once its check has shown: it is the code taken and the
    /// scanner wasn't closed meanwhile.
    func handsBack(_ code: String) -> Bool { !closed && phase == .found(code) }

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
