#if os(iOS)
import Foundation
import WidgetKit
import TallylineCore

/// Writes the widget snapshot from the app's own data and asks WidgetKit to
/// redraw. The network calls here run in the app; the widget only reads.
@MainActor
enum WidgetBridge {
    /// Writes twice: first from the local cache alone (fast, works offline and
    /// when the app is about to be suspended), then with fresh review and
    /// cycle numbers from the server.
    static func refresh(session: SessionModel) async {
        guard case let .signedIn(credential) = session.state, let store = WidgetSnapshot.sharedStore() else { return }
        let previous = try? store.read()

        func write(reviewCount: Int, cycles: [Cycle]?) {
            var snapshot = WidgetSnapshot.build(
                workspaceName: credential.workspaceName,
                userId: credential.userId,
                issues: session.offline.cache?.issues ?? [],
                reviewCount: reviewCount,
                cycles: cycles ?? []
            )
            // No fresh cycles (offline): keep the last known one.
            if cycles == nil { snapshot.cycle = previous?.cycle }
            try? store.write(snapshot)
            WidgetCenter.shared.reloadAllTimelines()
        }

        write(reviewCount: previous?.reviewCount ?? 0, cycles: nil)
        guard let client = session.client else { return }
        let queue = try? await client.reviewQueue(ws: credential.workspaceSlug)
        let cycles = try? await client.cycles(ws: credential.workspaceSlug)
        if queue != nil || cycles != nil {
            write(reviewCount: queue?.count ?? previous?.reviewCount ?? 0, cycles: cycles)
        }
    }

    static func clear() {
        try? WidgetSnapshot.sharedStore()?.delete()
        WidgetCenter.shared.reloadAllTimelines()
    }
}
#endif
