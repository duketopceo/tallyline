#if os(iOS)
import SwiftUI
import UIKit
import UserNotifications
import TallylineCore
import TallylineDesign

/// Push on the phone: permission, the APNs token, registration through the
/// relay (docs/push.md), and where a tapped notification should land.
@MainActor @Observable
final class PushCenter {
    static let shared = PushCenter()

    enum Status: Equatable {
        case checking
        case notAsked
        case denied
        case serverOff
        case on
        case failed
    }

    private(set) var status: Status = .checking
    /// Set when a notification is tapped; HomeView switches tabs and clears it.
    var pendingDestination: PushDestination?

    @ObservationIgnored weak var session: SessionModel?
    @ObservationIgnored private var token: Data?

    static var environment: PushEnvironment {
        #if DEBUG
        .sandbox
        #else
        .production
        #endif
    }

    /// Check permission and, if already granted, fetch a fresh APNs token.
    /// Never prompts; the prompt waits for the user to ask (settingsRow).
    func refresh() async {
        let current = await UNUserNotificationCenter.current().notificationSettings()
        switch current.authorizationStatus {
        case .notDetermined:
            status = .notAsked
        case .denied:
            status = .denied
        default:
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    func askPermission() async {
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        if granted {
            UIApplication.shared.registerForRemoteNotifications()
        } else {
            status = .denied
        }
    }

    func tokenArrived(_ data: Data) {
        token = data
        Task { await register() }
    }

    func tokenFailed() {
        status = .failed
    }

    func register() async {
        guard let token, let api = api() else { return }
        do {
            switch try await PushRegistrar.register(token: token, environment: Self.environment, api: api) {
            case .registered: status = .on
            case .serverPushOff: status = .serverOff
            }
        } catch {
            status = .failed
        }
    }

    /// Drop this phone's handle on the server. Best effort: revoking the
    /// device on the server clears it too.
    func unregister() async {
        try? await api()?.clearDeviceHandle()
        status = .checking
    }

    func api() -> LivePushAPI? {
        guard let session, case let .signedIn(credential) = session.state, let client = session.client else { return nil }
        return LivePushAPI(client: client, workspaceSlug: credential.workspaceSlug)
    }

    func open(_ kind: PushKind) {
        pendingDestination = kind.destination
    }

    /// One category per kind so the relay's `aps.category` resolves. Alerts
    /// are fixed text from the relay, so no actions and no service extension.
    static var categories: Set<UNNotificationCategory> {
        Set(PushKind.allCases.map { UNNotificationCategory(identifier: $0.rawValue, actions: [], intentIdentifiers: []) })
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories(PushCenter.categories)
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushCenter.shared.tokenArrived(deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        PushCenter.shared.tokenFailed()
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let kind = PushKind.from(userInfo: response.notification.request.content.userInfo) else { return }
        await MainActor.run { PushCenter.shared.open(kind) }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }
}

extension HomeSection {
    init(_ destination: PushDestination) {
        switch destination {
        case .myIssues: self = .issues
        case .review: self = .review
        }
    }
}

/// Settings > Notifications: turn push on, pick kinds, set quiet hours.
struct NotificationSettingsView: View {
    var push: PushCenter
    @State private var prefs: PushPreferences?
    @State private var saveError: String?

    var body: some View {
        Form {
            Section { statusRow }
            if let prefs {
                Section("Notify me about") {
                    ForEach(PushKind.allCases) { kind in
                        Toggle(kind.settingsLabel, isOn: Binding(
                            get: { prefs.isEnabled(kind) },
                            set: { on in update { $0.set(kind, enabled: on) } }
                        ))
                    }
                }
                Section {
                    Toggle("Quiet hours", isOn: Binding(
                        get: { prefs.hasQuietHours },
                        set: { on in update { $0.setQuietHours(on) } }
                    ))
                    if prefs.hasQuietHours {
                        DatePicker("From", selection: time(\.quietStart), displayedComponents: .hourAndMinute)
                        DatePicker("Until", selection: time(\.quietEnd), displayedComponents: .hourAndMinute)
                    }
                } footer: {
                    if prefs.hasQuietHours {
                        Text("Nothing is sent between these times (\(prefs.tz ?? TimeZone.current.identifier)).")
                    }
                }
            }
            if let saveError {
                Text(saveError).font(.caption).foregroundStyle(Theme.urgent)
            }
        }
        .navigationTitle("Notifications")
        .task {
            await push.refresh()
            prefs = try? await push.api()?.preferences()
        }
    }

    @ViewBuilder
    private var statusRow: some View {
        switch push.status {
        case .checking:
            ProgressView()
        case .notAsked:
            Button("Turn on notifications") { Task { await push.askPermission() } }
        case .denied:
            VStack(alignment: .leading, spacing: 4) {
                Text("Notifications are off for Tallyline in iOS Settings.")
                Button("Open iOS Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                }
            }
        case .serverOff:
            Text("This server has notifications turned off.").foregroundStyle(Theme.inkMuted)
        case .on:
            Label("On for this phone", systemImage: "bell.badge")
        case .failed:
            VStack(alignment: .leading, spacing: 4) {
                Text("Could not turn on notifications.").foregroundStyle(Theme.urgent)
                Button("Try again") { Task { await push.refresh() } }
            }
        }
    }

    private func update(_ change: (inout PushPreferences) -> Void) {
        guard var next = prefs else { return }
        change(&next)
        prefs = next
        Task {
            do {
                if let saved = try await push.api()?.savePreferences(next) { prefs = saved }
                saveError = nil
            } catch {
                saveError = "Could not save. Check your connection."
            }
        }
    }

    private func time(_ key: WritableKeyPath<PushPreferences, Int?>) -> Binding<Date> {
        Binding(
            get: {
                let minutes = prefs?[keyPath: key] ?? 0
                return Calendar.current.date(bySettingHour: minutes / 60, minute: minutes % 60, second: 0, of: .now) ?? .now
            },
            set: { date in
                let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
                update { $0[keyPath: key] = PushPreferences.minutes(hour: parts.hour ?? 0, minute: parts.minute ?? 0) }
            }
        )
    }
}
#endif
