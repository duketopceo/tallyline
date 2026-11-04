#if os(iOS)
@preconcurrency import AVFoundation
import AuthenticationServices
import CryptoKit
import SwiftUI
import TallylineCore
import TallylineDesign
import UIKit

/// Cloud: Sign in with Apple → api.tallyline.app. Self-host: pair with a code.
struct InstancePickerView: View {
    var session: SessionModel
    @State private var serverText = TallylineConfig.defaultServerURL.absoluteString
    @State private var showSelfHost = false
    @State private var appleBusy = false
    @State private var rawNonce = ""

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    VStack(spacing: 8) {
                        Text("tallyline")
                            .font(.title.bold())
                        Text("Sign in to a workspace")
                            .foregroundStyle(Theme.inkMuted)
                    }

                    SignInWithAppleButton(.signIn) { request in
                        let nonce = Self.randomNonce()
                        rawNonce = nonce
                        request.requestedScopes = [.fullName, .email]
                        request.nonce = Self.sha256(nonce)
                    } onCompletion: { result in
                        Task { await handleApple(result) }
                    }
                    .signInWithAppleButtonStyle(.black)
                    // Accessibility audit: hit area ≥ 44×44; prefer a tall control
                    // so default Dynamic Type still clears the gate.
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .padding(.horizontal, 24)
                    .disabled(appleBusy)

                    if let error = session.lastError {
                        Text(error)
                            .font(.callout)
                            .foregroundStyle(Theme.urgent)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal)
                    }

                    Button {
                        showSelfHost.toggle()
                    } label: {
                        Text(showSelfHost ? "Hide self-hosted options" : "Self-hosted or pairing code")
                            .font(.callout)
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.inkMuted)
                    .padding(.horizontal, 24)

                    if showSelfHost {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Server")
                                .font(.caption)
                                .foregroundStyle(Theme.inkSubtle)
                            TextField("https://api.tallyline.app", text: $serverText, axis: .vertical)
                                .textFieldStyle(.roundedBorder)
                                .keyboardType(.URL)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        }
                        .padding(.horizontal)
                        NavigationLink(value: "pair") {
                            Text("Continue with pairing")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(Theme.accent)
                        .padding(.horizontal)
                        .disabled(URL(string: normalizedServer) == nil)
                    }
                }
                .padding(.vertical, 48)
                .frame(maxWidth: .infinity)
            }
            .navigationDestination(for: String.self) { _ in
                PairView(session: session, serverURL: URL(string: normalizedServer)!)
            }
        }
    }

    private var normalizedServer: String {
        var s = serverText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !s.isEmpty && !s.contains("://") { s = "https://" + s }
        return s
    }

    private func handleApple(_ result: Result<ASAuthorization, Error>) async {
        appleBusy = true
        defer { appleBusy = false }
        switch result {
        case .failure(let error):
            if let asErr = error as? ASAuthorizationError, asErr.code == .canceled {
                session.clearError()
                return
            }
            session.setError(error.localizedDescription)
        case .success(let auth):
            guard let cred = auth.credential as? ASAuthorizationAppleIDCredential,
                  let tokenData = cred.identityToken,
                  let identityToken = String(data: tokenData, encoding: .utf8) else {
                session.setError("Apple did not return an identity token")
                return
            }
            do {
                try await session.signInWithApple(
                    identityToken: identityToken,
                    rawNonce: rawNonce,
                    deviceName: UIDevice.current.name,
                    serverURL: TallylineConfig.defaultServerURL
                )
            } catch {
                // SessionModel already sets lastError; keep a fallback message.
                if session.lastError == nil {
                    session.setError(error.localizedDescription)
                }
            }
        }
    }

    private static func randomNonce(length: Int = 32) -> String {
        var bytes = [UInt8](repeating: 0, count: length)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        precondition(status == errSecSuccess, "SecRandomCopyBytes failed")
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func sha256(_ input: String) -> String {
        let digest = SHA256.hash(data: Data(input.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}

/// Paste or scan a `tlpair_…` code from Settings → Devices in the web app.
struct PairView: View {
    var session: SessionModel
    let serverURL: URL
    @State private var code = ""
    @State private var busy = false
    @State private var showScanner = false

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Text("Pair this device")
                .font(.title2.bold())
            Text("In the web app, open Settings → Devices and create a pairing code.")
                .font(.callout)
                .foregroundStyle(Theme.inkMuted)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
            VStack(spacing: 12) {
                TextField("tlpair_…", text: $code)
                    .textFieldStyle(.roundedBorder)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.body.monospaced())
                Button {
                    showScanner = true
                } label: {
                    Label("Scan QR code", systemImage: "qrcode.viewfinder")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                Button {
                    Task { await redeem() }
                } label: {
                    if busy { ProgressView().frame(maxWidth: .infinity) }
                    else { Text("Pair device").frame(maxWidth: .infinity) }
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
                .disabled(code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
            }
            .padding(.horizontal)
            if let error = session.lastError {
                Text(error)
                    .font(.callout)
                    .foregroundStyle(Theme.urgent)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
            }
            Spacer()
        }
        .sheet(isPresented: $showScanner) {
            QRScannerView { scanned in
                showScanner = false
                if let server = PairingCode.suggestedServer(scanned) {
                    Task {
                        try? await session.pair(code: scanned, deviceName: UIDevice.current.name, serverURL: server)
                    }
                } else {
                    code = scanned
                }
            }
        }
    }

    private func redeem() async {
        busy = true
        defer { busy = false }
        try? await session.pair(code: code, deviceName: UIDevice.current.name, serverURL: serverURL)
    }
}

/// AVFoundation QR reader wrapped for SwiftUI. Emits the first `tlpair_` or
/// `tallyline://pair` payload it sees, then closes.
struct QRScannerView: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let vc = ScannerController()
        vc.onCode = onCode
        return vc
    }

    func updateUIViewController(_ uiViewController: ScannerController, context: Context) {}

    @MainActor final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        var onCode: ((String) -> Void)?
        private let captureSession = AVCaptureSession()
        private var fired = false

        override func viewDidLoad() {
            super.viewDidLoad()
            guard let device = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: device),
                  captureSession.canAddInput(input) else { return }
            captureSession.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard captureSession.canAddOutput(output) else { return }
            captureSession.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
            let preview = AVCaptureVideoPreviewLayer(session: captureSession)
            preview.videoGravity = .resizeAspectFill
            preview.frame = view.bounds
            view.layer.addSublayer(preview)
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            view.layer.sublayers?.first?.frame = view.bounds
        }

        override func viewWillAppear(_ animated: Bool) {
            super.viewWillAppear(animated)
            DispatchQueue.global().async { self.captureSession.startRunning() }
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            captureSession.stopRunning()
        }

        nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
            guard let payload = (objects.first as? AVMetadataMachineReadableCodeObject)?.stringValue,
                  payload.hasPrefix("tlpair_") || payload.hasPrefix("tallyline://") else { return }
            MainActor.assumeIsolated {
                guard !fired else { return }
                fired = true
                onCode?(payload)
            }
        }
    }
}
#endif
