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

/// The live camera behind the scanner's frame. It reports every QR code it reads and whether it
/// could start; the scanner decides what they mean (`ScannerModel`).
struct CameraPreview: UIViewControllerRepresentable {
    let read: @MainActor (String) -> Void
    let failed: @MainActor () -> Void
    let torch: Bool
    /// A code was taken: stop reading and keep the last picture.
    let held: Bool
    let torchAvailable: @MainActor (Bool) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.read = read
        controller.failed = failed
        controller.torchAvailable = torchAvailable
        return controller
    }
    func updateUIViewController(_ controller: ScannerController, context: Context) {
        controller.read = read
        controller.setTorch(torch)
        if held { controller.hold() }
    }
}

final class ScannerController: UIViewController, @preconcurrency AVCaptureMetadataOutputObjectsDelegate {
    var read: (@MainActor (String) -> Void)?
    var failed: (@MainActor () -> Void)?
    var torchAvailable: (@MainActor (Bool) -> Void)?
    /// Apple documents start/stop as blocking calls for a background serial queue.
    private final class Capture: @unchecked Sendable {
        let session = AVCaptureSession()
        var camera: AVCaptureDevice?
    }
    private let capture = Capture()
    private let sessionQueue = DispatchQueue(label: "ace.camera.session")
    private var preview: AVCaptureVideoPreviewLayer?
    private var lifetime = PairingLifetime()
    private var torchOn = false
    private var held = false

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        _ = lifetime.enter()
        view.backgroundColor = .black
        guard !held else { return }
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
            let hasTorch = camera.hasTorch
            Task { @MainActor [weak self] in self?.torchAvailable?(hasTorch) }
        }
        let capture = capture
        sessionQueue.async { capture.session.startRunning() }
        return true
    }
    func setTorch(_ on: Bool) {
        guard on != torchOn else { return }
        torchOn = on
        let capture = capture
        sessionQueue.async {
            guard let camera = capture.camera, camera.hasTorch, (try? camera.lockForConfiguration()) != nil else { return }
            camera.torchMode = on ? .on : .off
            camera.unlockForConfiguration()
        }
    }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }
    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        lifetime.leave()
        let capture = capture
        sessionQueue.async { capture.session.stopRunning() }
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
        sessionQueue.async { capture.session.stopRunning() }
    }
}
