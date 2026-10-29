#if os(iOS)
import SwiftUI
import UIKit
import TallylineCore
import TallylineDesign

@main
struct TallylineApp: App {
    @State private var session = SessionModel(store: KeychainCredentialStore())

    var body: some Scene {
        WindowGroup {
            RootView(session: session)
                .background(Theme.canvas.ignoresSafeArea())
                .task { await session.rotateIfNeeded() }
                .onOpenURL { url in
                    // tallyline://pair?s=<server>&c=<code> — straight into pairing.
                    if url.host == "pair" {
                        let server = PairingCode.suggestedServer(url.absoluteString) ?? TallylineConfig.defaultServerURL
                        let code = PairingCode.normalize(url.absoluteString)
                        Task {
                            try? await session.pair(code: code, deviceName: UIDeviceName.current, serverURL: server)
                        }
                    }
                }
        }
    }
}

enum UIDeviceName {
    static var current: String { UIDevice.current.name }
}

struct RootView: View {
    var session: SessionModel

    var body: some View {
        switch session.state {
        case .signedOut:
            InstancePickerView(session: session)
        case .pairing(let serverURL):
            PairView(session: session, serverURL: serverURL)
        case .signedIn(let credential):
            HomeView(session: session, credential: credential)
        }
    }
}
#endif
