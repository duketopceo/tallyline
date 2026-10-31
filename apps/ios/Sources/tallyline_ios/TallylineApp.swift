#if os(iOS)
import SwiftUI
import UIKit
import TallylineCore
import TallylineDesign

@main
struct TallylineApp: App {
    @State private var session = SessionModel(store: KeychainCredentialStore())
    @AppStorage("appearance") private var appearance = SilverLiningAppearance.system.rawValue

    var body: some Scene {
        WindowGroup {
            RootView(session: session)
                .background(Theme.canvas.ignoresSafeArea())
                .preferredColorScheme((SilverLiningAppearance(rawValue: appearance) ?? .system).colorScheme)
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
        case .signedIn(let credential):
            HomeView(session: session, credential: credential)
        }
    }
}
#endif
