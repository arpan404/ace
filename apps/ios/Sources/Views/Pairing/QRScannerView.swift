import AVFoundation
import SwiftUI
import UIKit

/// Live camera QR scanning. The decoded text is handed back once and never stored.
struct QRScannerView: UIViewControllerRepresentable {
    let found: @MainActor (String) -> Void
    let unavailable: @MainActor (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.found = found
        controller.unavailable = unavailable
        return controller
    }
    func updateUIViewController(_ controller: ScannerController, context: Context) {}
}

final class ScannerController: UIViewController, @preconcurrency AVCaptureMetadataOutputObjectsDelegate {
    var found: (@MainActor (String) -> Void)?
    var unavailable: (@MainActor (String) -> Void)?
    /// Apple documents start/stop as blocking calls for a background serial queue.
    private final class Capture: @unchecked Sendable { let session = AVCaptureSession() }
    private let capture = Capture()
    private var session: AVCaptureSession { capture.session }
    private let sessionQueue = DispatchQueue(label: "ace.camera.session")
    private var preview: AVCaptureVideoPreviewLayer?
    private var delivered = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: configure()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                Task { @MainActor [weak self] in
                    if granted { self?.configure() } else { self?.unavailable?("Camera access is off. Allow it in Settings, or paste the link instead.") }
                }
            }
        default: unavailable?("Camera access is off. Allow it in Settings, or paste the link instead.")
        }
    }
    private func configure() {
        guard let camera = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: camera),
              session.canAddInput(input) else {
            unavailable?("No camera is available. Paste the pairing link instead.")
            return
        }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { unavailable?("No camera is available. Paste the pairing link instead."); return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.addSublayer(layer)
        preview = layer
        let capture = capture
        sessionQueue.async { capture.session.startRunning() }
    }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }
    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        let capture = capture
        sessionQueue.async { capture.session.stopRunning() }
    }
    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !delivered, let code = objects.compactMap({ $0 as? AVMetadataMachineReadableCodeObject }).first?.stringValue else { return }
        delivered = true
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        let capture = capture
        sessionQueue.async { capture.session.stopRunning() }
        found?(code)
    }
}
