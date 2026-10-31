#if os(iOS)
import Foundation
import Network
import Observation
import TallylineCore

/// What happened to a write the person just made.
enum SubmitOutcome: Equatable {
    /// The server has it.
    case sent
    /// Saved on the phone; it sends when the network is back.
    case queued
    /// The server refused it. Shown inline; nothing stays queued.
    case rejected(String)
}

/// Offline layer: the issue cache (read first, revalidated by delta) and the
/// outbox (every write goes through it). Logic lives in TallylineCore.
@MainActor @Observable
final class OfflineModel {
    private(set) var entries: [OutboxEntry] = []
    private(set) var isOnline = true
    private(set) var cache: IssueCacheSnapshot?

    var failedCount: Int { entries.filter { if case .failed = $0.status { true } else { false } }.count }

    private let outbox: Outbox
    private let cacheStore: JSONFileStore<IssueCacheSnapshot>
    private let client: @MainActor () -> APIClient?
    private let monitor = NWPathMonitor()
    private var wakeTask: Task<Void, Never>?

    init(client: @escaping @MainActor () -> APIClient?) {
        self.client = client
        self.outbox = Outbox(store: JSONFileStore<[OutboxEntry]>.standard(named: "outbox"))
        self.cacheStore = JSONFileStore<IssueCacheSnapshot>.standard(named: "issue-cache")
        self.cache = try? cacheStore.read()
        monitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            Task { @MainActor in self?.setOnline(online) }
        }
        monitor.start(queue: DispatchQueue(label: "app.tallyline.ios.network"))
        Task { await refreshEntries() }
    }

    // ── Writes ──────────────────────────────────────────────────────────

    /// Queue a write and try to send it now.
    func submit(_ operation: OutboxOperation, workspaceSlug: String) async -> SubmitOutcome {
        guard let entry = try? await outbox.enqueue(operation, workspaceSlug: workspaceSlug) else {
            return .rejected("Could not save the change on this phone")
        }
        await drain()
        if let current = entries.first(where: { $0.id == entry.id }) {
            if case .failed(let reason) = current.status {
                // The person is looking at the result; tell them and do not keep it.
                try? await outbox.discard(entry.id)
                await refreshEntries()
                return .rejected(reason)
            }
            return .queued
        }
        return .sent
    }

    func drain() async {
        guard let client = client() else { return }
        _ = await outbox.drain(using: TrackerOutboxSender(client: client))
        await refreshEntries()
        await scheduleWake()
    }

    /// Move issues the share extension could not send into the outbox, keeping
    /// their ids (the idempotency key), then send.
    func importSharedDrafts() async {
        guard let inbox = ShareInbox.shared() else { return }
        let drafts = inbox.pending()
        guard !drafts.isEmpty else { return }
        let queued = Set(await outbox.all.map(\.id))
        for item in drafts {
            if !queued.contains(item.id) {
                guard (try? await outbox.enqueue(.createIssue(item.draft), workspaceSlug: item.workspaceSlug, id: item.id)) != nil else { continue }
            }
            inbox.remove(item.id)
        }
        await drain()
    }

    func retry(_ id: String) async {
        try? await outbox.retry(id)
        await drain()
    }

    func discard(_ id: String) async {
        try? await outbox.discard(id)
        await refreshEntries()
    }

    // ── Reads ───────────────────────────────────────────────────────────

    func cachedIssues(workspaceSlug: String, state: IssueState?) -> [Issue] {
        guard let cache, cache.workspaceSlug == workspaceSlug else { return [] }
        return cache.issues(in: state)
    }

    /// Fetch what changed since the last sync and merge it into the cache.
    /// The first sync (or a workspace switch) loads everything.
    func syncIssues(workspaceSlug: String) async throws {
        guard let client = client() else { return }
        var snapshot = (cache?.workspaceSlug == workspaceSlug ? cache : nil) ?? IssueCacheSnapshot(workspaceSlug: workspaceSlug)
        // Back off five minutes from our own clock so skew cannot skip a change.
        // Repeats are harmless: merge keeps the newer row.
        let startedAt = Date().addingTimeInterval(-300)
        let delta = try await client.issues(ws: workspaceSlug, updatedSince: snapshot.syncedAt)
        snapshot.merge(delta, syncedAt: startedAt)
        cache = snapshot
        try? cacheStore.write(snapshot)
    }

    /// Reflect a local change before the server confirms it.
    func applyLocally(_ issue: Issue) {
        guard var snapshot = cache else { return }
        snapshot.issues.removeAll { $0.id == issue.id }
        snapshot.issues.insert(issue, at: 0)
        cache = snapshot
        try? cacheStore.write(snapshot)
    }

    /// Sign-out: nothing from this workspace stays on the phone.
    func wipe() async {
        wakeTask?.cancel()
        try? await outbox.wipe()
        try? cacheStore.delete()
        if let inbox = ShareInbox.shared() {
            for item in inbox.pending() { inbox.remove(item.id) }
        }
        cache = nil
        await refreshEntries()
    }

    // ── Internals ───────────────────────────────────────────────────────

    private func setOnline(_ online: Bool) {
        let cameBack = online && !isOnline
        isOnline = online
        if cameBack { Task { await drain() } }
    }

    private func refreshEntries() async {
        entries = await outbox.all
    }

    private func scheduleWake() async {
        wakeTask?.cancel()
        guard let wake = await outbox.nextWake() else { return }
        let delay = max(0.5, wake.timeIntervalSinceNow)
        wakeTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await self?.drain()
        }
    }
}
#endif
