#if os(iOS)
import SwiftUI
import UIKit
import TallylineCore
import TallylineDesign

@main
struct TallylineApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var session = SessionModel.shared
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("appearance") private var appearance = SilverLiningAppearance.system.rawValue

    var body: some Scene {
        WindowGroup {
            RootView(session: session)
                .background(Theme.canvas.ignoresSafeArea())
                .preferredColorScheme((SilverLiningAppearance(rawValue: appearance) ?? .system).colorScheme)
                .task { await session.rotateIfNeeded() }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .background { Task { await WidgetBridge.refresh(session: session) } }
                    if phase == .active { Task { await session.offline.importSharedDrafts() } }
                }
                .onOpenURL { url in
                    // tallyline://open/issues|review from widgets and shortcuts.
                    if let destination = AppLink.destination(url) {
                        AppRouter.shared.open(destination)
                        return
                    }
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
                // Re-register on every sign-in and launch; see PushRegistrar.
                .task(id: credential.token) {
                    PushCenter.shared.session = session
                    await PushCenter.shared.refresh()
                    await WidgetBridge.refresh(session: session)
                }
        }
    }
}
#endif
