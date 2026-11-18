import AVFoundation
import SwiftUI
import UIKit

/// What the phone's camera can do for the scanner right now. Fixture launches can stand in for
/// it (`--spike-camera`), so the denied and no-camera screens can be seen on a simulator.
struct CameraProbe {
    var access: CameraAccess
    var hasCamera: Bool
    /// Draw the live camera; a stand-in shows the scanner over black.
    var live: Bool
    /// A fixture's stand-in code, read a moment after the scanner opens (`--spike-scan`).
    var standInCode: String? = nil

    static func current() -> CameraProbe {
        if let standIn = SpikeConfiguration.camera { return standIn }
        let access: CameraAccess = switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: .allowed
        case .notDetermined: .undecided
        case .restricted: .restricted
        default: .denied
        }
        return CameraProbe(access: access, hasCamera: AVCaptureDevice.default(for: .video) != nil, live: true)
    }

    /// Asks once, as the system's prompt does; the answer arrives off the main actor.
    static func requestAccess() async -> Bool { await AVCaptureDevice.requestAccess(for: .video) }
}

/// The live camera behind the scanner's frame. It reports every QR code it reads, a camera that
/// won't start or stops with an error, and the torch as it really is; the scanner decides what
/// they mean (`ScannerModel`). Removing it stops the camera.
struct CameraPreview: UIViewControllerRepresentable {
    let read: @MainActor (String) -> Void
    let failed: @MainActor () -> Void
    /// The torch the person asked for.
    let torch: Bool
    /// A code was taken: stop reading and keep the last picture.
    let held: Bool
    let torchAvailable: @MainActor (Bool) -> Void
    /// Whether the torch is on after a change, which may differ from what was asked.
    let torchApplied: @MainActor (Bool) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.read = read
        controller.failed = failed
        controller.torchAvailable = torchAvailable
        controller.torchApplied = torchApplied
        return controller
    }
    func updateUIViewController(_ controller: ScannerController, context: Context) {
        controller.read = read
        controller.torchApplied = torchApplied
        controller.setTorch(torch)
        if held { controller.hold() }
    }
    static func dismantleUIViewController(_ controller: ScannerController, coordinator: ()) { controller.stop() }
}

final class ScannerController: UIViewController, @preconcurrency AVCaptureMetadataOutputObjectsDelegate {
    var read: (@MainActor (String) -> Void)?
    var failed: (@MainActor () -> Void)?
    var torchAvailable: (@MainActor (Bool) -> Void)?
    var torchApplied: (@MainActor (Bool) -> Void)?
    /// Apple documents start/stop as blocking calls for a background serial queue.
    private final class Capture: @unchecked Sendable {
        let session = AVCaptureSession()
        var camera: AVCaptureDevice?

        /// Sets the torch where the camera has one, it's usable now (not too hot) and supports
        /// the mode; returns whether it is on afterwards.
        func applyTorch(_ on: Bool) -> Bool {
            guard let camera, camera.hasTorch else { return false }
            let mode: AVCaptureDevice.TorchMode = on ? .on : .off
            if camera.isTorchAvailable || !on, camera.isTorchModeSupported(mode), (try? camera.lockForConfiguration()) != nil {
                camera.torchMode = mode
                camera.unlockForConfiguration()
            }
            return camera.torchMode == .on
        }
    }
    private let capture = Capture()
    private let sessionQueue = DispatchQueue(label: "ace.camera.session")
    private var preview: AVCaptureVideoPreviewLayer?
    private var lifetime = PairingLifetime()
    /// The torch as last asked for or applied.
    private var torchOn = false
    private var held = false
    private var stopped = false
    private var observers: [NSObjectProtocol] = []

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        _ = lifetime.enter()
        view.backgroundColor = .black
        guard !held, !stopped else { return }
        // Reported after this pass, never while SwiftUI is still presenting the scanner.
        if !configure() { Task { @MainActor [weak self] in self?.failed?() } }
    }
    private func configure() -> Bool {
        if preview == nil {
            let session = capture.session
            guard let camera = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: camera),
                  session.canAddInput(input) else { return false }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { return false }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            layer.frame = view.bounds
            view.layer.addSublayer(layer)
            preview = layer
            capture.camera = camera
            observe(session)
            let hasTorch = camera.hasTorch && camera.isTorchModeSupported(.on)
            Task { @MainActor [weak self] in self?.torchAvailable?(hasTorch) }
        }
        let capture = capture
        sessionQueue.async { capture.session.startRunning() }
        return true
    }
    /// A session that fails to start or stops with an error says so through the runtime error
    /// notification; leaving for the background stops the camera rather than letting the system
    /// resume it on return, when the scanner decides afresh.
    private func observe(_ session: AVCaptureSession) {
        let centre = NotificationCenter.default
        observers.append(centre.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.failed?() }
        })
        observers.append(centre.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.stop() }
        })
    }
    func setTorch(_ on: Bool) {
        guard on != torchOn, !stopped else { return }
        torchOn = on
        let capture = capture
        sessionQueue.async { [weak self] in
            let lit = capture.applyTorch(on)
            Task { @MainActor in
                self?.torchOn = lit
                self?.torchApplied?(lit)
            }
        }
    }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }
    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        stop()
    }
    /// Stops for good: the scanner went away or the app went to the background. Coming back
    /// builds a new camera view.
    func stop() {
        guard !stopped else { return }
        stopped = true
        lifetime.leave()
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        torchOn = false
        // After this pass: stopping can happen while SwiftUI removes the camera view.
        let report = torchApplied
        Task { @MainActor in report?(false) }
        let capture = capture
        sessionQueue.async {
            _ = capture.applyTorch(false)
            capture.session.stopRunning()
        }
    }
    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard lifetime.acceptsCurrent else { return }
        for code in objects.compactMap({ ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }) { read?(code) }
    }
    /// Freezes the picture once a code is taken, so nothing more is read while the scanner closes.
    func hold() {
        guard !held else { return }
        held = true
        let capture = capture
        sessionQueue.async {
            _ = capture.applyTorch(false)
            capture.session.stopRunning()
        }
    }
}
