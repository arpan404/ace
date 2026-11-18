import SwiftUI
import UIKit

/// Scans the pairing code on the computer's screen: the camera full screen, dimmed around a
/// rounded frame, one line saying what to point at, and the torch and Paste link as glass
/// buttons. A good code flashes a check with a success tap before it's handed back; one that
/// isn't a pairing link says so and scanning goes on. With access off, or no camera at all,
/// the scanner says so in place and offers Settings or Paste: it never closes on its own.
/// The decoded text is handed back once and never stored.
struct QRScannerView: View {
    /// Why a code can't pair, or nil when it can.
    let check: (String) -> String?
    let found: (String) -> Void
    let paste: () -> Void
    let close: () -> Void
    @State private var probe: CameraProbe?
    @State private var model: ScannerModel?
    @State private var torch = false
    @State private var torchAvailable = false
    @State private var rejections = 0
    @Environment(\.openURL) private var openURL
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme

    private var dark: Bool { model?.showsCamera != false }

    var body: some View {
        NavigationStack {
            ZStack {
                if let model, let probe {
                    if model.showsCamera { camera(model, live: probe.live) } else { unavailable(model.phase) }
                } else {
                    Color.black.ignoresSafeArea()
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(action: close) { Image(systemName: "xmark") }
                        .accessibilityLabel("Close").accessibilityIdentifier("scanner.close")
                }
            }
            .toolbarBackground(.hidden, for: .navigationBar)
            // Dark over the camera, the person's own appearance otherwise. Set here, never with
            // `preferredColorScheme`: that reaches the window and closes the pairing sheet.
            .toolbarColorScheme(dark ? .dark : nil, for: .navigationBar)
            .environment(\.colorScheme, dark ? .dark : scheme)
        }
        .sensoryFeedback(.success, trigger: model?.phase) { _, phase in if case .found = phase { true } else { false } }
        .sensoryFeedback(.warning, trigger: rejections)
        .task { await start() }
    }

    // MARK: Camera

    private func camera(_ model: ScannerModel, live: Bool) -> some View {
        GeometryReader { space in
            let side = min(min(space.size.width, space.size.height) * ScannerLook.frameShare, ScannerLook.frameMax)
            let centre = CGPoint(x: space.size.width / 2, y: space.size.height / 2 - ScannerLook.lift)
            let found = if case .found = model.phase { true } else { false }
            ZStack {
                Color.black
                if live && model.phase != .asking {
                    CameraPreview(read: { read($0) }, failed: { self.model?.cameraFailed() }, torch: torch, held: found,
                                  torchAvailable: { torchAvailable = $0 })
                }
                ScannerDim(side: side, centre: centre)
                ScannerFrame(side: side, found: found, reduceMotion: reduceMotion)
                    .overlay(alignment: .top) {
                        Text(model.note ?? "Scan the code shown on your computer")
                            .font(AceDesign.Typeface.body.weight(AceDesign.Typeface.strong))
                            .foregroundStyle(.white).multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(width: space.size.width - 2 * AceDesign.Space.section)
                            .alignmentGuide(.top) { $0[.bottom] + AceDesign.Space.group }
                            .accessibilityIdentifier("scanner.instruction")
                    }
                    .position(centre)
            }
            .frame(width: space.size.width, height: space.size.height)
        }
        .ignoresSafeArea()
        .overlay(alignment: .bottom) { controls(model) }
    }

    private func controls(_ model: ScannerModel) -> some View {
        HStack(spacing: AceDesign.Space.row) {
            if torchAvailable {
                Button { torch.toggle() } label: {
                    Image(systemName: torch ? "flashlight.on.fill" : "flashlight.off.fill")
                        .frame(width: AceDesign.Size.tap - AceDesign.Space.row)
                }
                .pairingSecondaryButton()
                .accessibilityLabel(torch ? "Turn torch off" : "Turn torch on")
                .accessibilityIdentifier("scanner.torch")
            }
            Button("Paste link instead", action: paste)
                .pairingSecondaryButton()
                .accessibilityIdentifier("scanner.paste")
        }
        .disabled(model.phase != .scanning && model.phase != .asking)
        .padding(.bottom, AceDesign.Space.section)
    }

    // MARK: Can't scan

    @ViewBuilder private func unavailable(_ phase: ScannerPhase) -> some View {
        let words = ScannerWords(phase)
        ContentUnavailableView {
            Label(words.title, systemImage: words.symbol)
        } description: {
            Text(words.line)
        } actions: {
            VStack(spacing: AceDesign.Space.row) {
                if phase == .denied || phase == .restricted {
                    Button("Open Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                    }
                    .pairingPrimaryButton()
                    .accessibilityIdentifier("scanner.settings")
                    Button("Paste link instead", action: paste).pairingSecondaryButton()
                        .accessibilityIdentifier("scanner.paste")
                } else {
                    Button("Paste link", action: paste).pairingPrimaryButton()
                        .accessibilityIdentifier("scanner.paste")
                }
            }
        }
        .accessibilityIdentifier("scanner.unavailable")
    }

    // MARK: Decisions

    private func start() async {
        let probe = CameraProbe.current()
        self.probe = probe
        var model = ScannerModel(access: probe.access, hasCamera: probe.hasCamera)
        self.model = model
        if model.phase == .asking {
            let granted = await CameraProbe.requestAccess()
            guard !Task.isCancelled else { return }
            model.answered(granted: granted)
            self.model?.answered(granted: granted)
        }
        if let code = probe.standInCode, model.phase == .scanning {
            try? await Task.sleep(for: ScannerLook.standInDelay)
            guard !Task.isCancelled else { return }
            read(code)
        }
    }

    private func read(_ code: String) {
        guard var model else { return }
        let reading = model.read(code, problem: check(code))
        self.model = model
        switch reading {
        case .accepted:
            Task {
                try? await Task.sleep(for: ScannerLook.checkHold)
                found(code)
            }
        case .rejected: rejections += 1
        case .ignored: break
        }
    }
}

/// The scanner's own measures: how much of the screen the frame takes, how dark the camera is
/// around it, and how long the check shows before the scanner closes.
private enum ScannerLook {
    static let frameShare: CGFloat = 0.68
    static let frameMax: CGFloat = 280
    static let stroke: CGFloat = 3
    static let dim: Double = 0.6
    /// Lifts the frame a little above centre, clear of the buttons at the foot.
    static let lift: CGFloat = 48
    static let checkHold: Duration = .milliseconds(500)
    static let standInDelay: Duration = .seconds(1)
    static var corner: CGFloat { AceDesign.Corner.device / 2 + AceDesign.Space.related }
}

/// The camera darkened everywhere but the frame.
private struct ScannerDim: View {
    let side: CGFloat
    let centre: CGPoint
    var body: some View {
        Rectangle().fill(.black.opacity(ScannerLook.dim))
            .mask {
                ZStack {
                    Rectangle()
                    RoundedRectangle(cornerRadius: ScannerLook.corner, style: .continuous)
                        .frame(width: side, height: side).position(centre).blendMode(.destinationOut)
                }
                .compositingGroup()
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

/// The frame's outline, and the check that flashes in it when a code is taken.
private struct ScannerFrame: View {
    let side: CGFloat
    let found: Bool
    let reduceMotion: Bool
    var body: some View {
        RoundedRectangle(cornerRadius: ScannerLook.corner, style: .continuous)
            .strokeBorder(found ? AceDesign.Status.finished : .white, lineWidth: ScannerLook.stroke)
            .frame(width: side, height: side)
            .overlay {
                if found {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: side / 4, weight: AceDesign.Typeface.strong))
                        .foregroundStyle(.white, AceDesign.Status.finished)
                        .transition(reduceMotion ? .opacity : .scale.combined(with: .opacity))
                        .accessibilityLabel("Code found")
                        .accessibilityIdentifier("scanner.found")
                }
            }
            .animation(reduceMotion ? nil : .spring, value: found)
    }
}

/// What the scanner says when it can't scan.
private struct ScannerWords {
    let title: String
    let line: String
    let symbol = "qrcode.viewfinder"
    init(_ phase: ScannerPhase) {
        switch phase {
        case .denied:
            title = "Camera access is off"
            line = "Allow ace to use the camera in Settings to scan the code, or paste the link from your computer."
        case .restricted:
            title = "Camera isn't allowed"
            line = "This iPhone's restrictions keep the camera off. Check Screen Time in Settings, or paste the link from your computer."
        default:
            title = "No camera"
            line = "There's no camera here to scan with. Copy the pairing link on your computer and paste it instead."
        }
    }
}
