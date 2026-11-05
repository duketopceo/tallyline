import Foundation
import XCTest
@testable import TallylineCore

/// One in-memory credential store per slug, as the Keychain keys by account.
private final class StoreMap: @unchecked Sendable {
    private let lock = NSLock()
    private var stores: [String: InMemoryCredentialStore] = [:]
    func store(_ slug: String) -> InMemoryCredentialStore {
        lock.withLock {
            if let s = stores[slug] { return s }
            let s = InMemoryCredentialStore()
            stores[slug] = s
            return s
        }
    }
}

final class WorkspaceSwitchTests: XCTestCase {
    private func member(_ slug: String, deleted: Bool = false, name: String? = nil) throws -> Whoami.Membership {
        let json = """
        {"workspaceSlug":"\(slug)","role":"member"\(name.map { ",\"workspaceName\":\"\($0)\"" } ?? "")\(deleted ? ",\"deletedAt\":\"2026-11-01T00:00:00Z\"" : "")}
        """
        return try JSONDecoder().decode(Whoami.Membership.self, from: Data(json.utf8))
    }

    private func credential(_ slug: String) -> DeviceCredential {
        DeviceCredential(token: "tly_pat_\(slug)", expiresAt: Date(timeIntervalSince1970: 2_000_000_000), deviceId: "d", userId: "u",
                         workspaceSlug: slug, workspaceName: slug.uppercased(), serverURL: URL(string: "https://api.example.com")!)
    }

    private func issue(_ id: String) -> Issue {
        Issue(
            id: id, key: "ENG-\(id)", number: Int(id) ?? 0, title: "t\(id)", description: nil,
            state: .todo, priority: .none, estimate: nil, dueDate: nil,
            assigneeType: nil, assigneeId: nil, delegateType: nil, delegateId: nil,
            creatorType: "human", creatorId: nil, projectId: nil, cycleId: nil, parentId: nil,
            source: "app", occurrenceCount: 1,
            createdAt: Date(timeIntervalSince1970: 0), updatedAt: Date(timeIntervalSince1970: 1)
        )
    }

    // ── Switcher visibility ─────────────────────────────────────────────

    func testSingleWorkspaceHasNoSwitcher() throws {
        XCTAssertEqual(WorkspaceSwitcher.choices(memberships: [try member("a")], current: "a", pairedSlugs: []), [])
        XCTAssertEqual(WorkspaceSwitcher.choices(memberships: [], current: "a", pairedSlugs: []), [])
    }

    func testWorkspaceWaitingForDeletionDoesNotCountAsASecond() throws {
        let choices = WorkspaceSwitcher.choices(memberships: [try member("a"), try member("gone", deleted: true)], current: "a", pairedSlugs: [])
        XCTAssertEqual(choices, [])
    }

    func testTwoWorkspacesListCurrentFirstAndMarkPairing() throws {
        let memberships = [try member("b", name: "Beta"), try member("a", name: "Alpha"), try member("c")]
        let choices = WorkspaceSwitcher.choices(memberships: memberships, current: "a", pairedSlugs: ["b"])
        XCTAssertEqual(choices.map(\.slug), ["a", "b", "c"])
        XCTAssertEqual(choices.map(\.name), ["Alpha", "Beta", "c"], "falls back to the slug when the server sends no name")
        XCTAssertEqual(choices.map(\.isPaired), [true, true, false])
        XCTAssertEqual(choices.map(\.isCurrent), [true, false, false])
    }

    func testOlderServerMembershipWithoutNameStillDecodes() throws {
        let m = try member("a")
        XCTAssertNil(m.workspaceName)
        XCTAssertNil(m.deletedAt)
    }

    // ── Credential shelf ────────────────────────────────────────────────

    func testShelfKeepsCredentialsPerWorkspaceAndGivesThemBackOnce() throws {
        let stores = StoreMap()
        let shelf = CredentialShelf { slug in stores.store(slug) }
        try shelf.shelve(credential("a"))
        try shelf.shelve(credential("b"))
        XCTAssertEqual(shelf.shelvedSlugs, ["a", "b"])
        XCTAssertEqual(try shelf.take("a")?.token, "tly_pat_a")
        XCTAssertNil(try shelf.take("a"), "taken means gone from the shelf")
        XCTAssertEqual(shelf.shelvedSlugs, ["b"])
        shelf.clear()
        XCTAssertEqual(shelf.shelvedSlugs, [])
        XCTAssertNil(try shelf.take("b"))
    }

    func testShelfIndexSurvivesRelaunch() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let backing = InMemoryCredentialStore()
        let first = CredentialShelf(index: JSONFileStore<[String]>.standard(named: "shelf", in: dir)) { _ in backing }
        try first.shelve(credential("b"))
        let second = CredentialShelf(index: JSONFileStore<[String]>.standard(named: "shelf", in: dir)) { _ in backing }
        XCTAssertEqual(second.shelvedSlugs, ["b"])
    }

    // ── Caches scoped per workspace ─────────────────────────────────────

    func testCachesAreSeparatePerWorkspace() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let caches = IssueCacheDirectory(directory: dir)
        try caches.store(for: "a").write(IssueCacheSnapshot(workspaceSlug: "a", issues: [issue("1")]))
        XCTAssertNil(try caches.store(for: "b").read(), "B starts empty, none of A's issues")
        try caches.store(for: "b").write(IssueCacheSnapshot(workspaceSlug: "b", issues: [issue("2")]))
        XCTAssertEqual(try caches.store(for: "a").read()?.issues.map(\.id), ["1"], "A is still warm after B was written")
        XCTAssertEqual(try caches.store(for: "b").read()?.issues.map(\.id), ["2"])
    }

    func testDeleteAllRemovesEveryWorkspaceCacheAndTheLegacyFile() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let caches = IssueCacheDirectory(directory: dir)
        try caches.store(for: "a").write(IssueCacheSnapshot(workspaceSlug: "a"))
        try caches.store(for: "b").write(IssueCacheSnapshot(workspaceSlug: "b"))
        try caches.legacyStore().write(IssueCacheSnapshot(workspaceSlug: "a"))
        let other = JSONFileStore<[String]>.standard(named: "shelf", in: dir)
        try other.write(["keep"])
        caches.deleteAll()
        XCTAssertNil(try caches.store(for: "a").read())
        XCTAssertNil(try caches.store(for: "b").read())
        XCTAssertNil(try caches.legacyStore().read())
        XCTAssertEqual(try other.read(), ["keep"], "only cache files go")
    }

    func testOddSlugCannotEscapeTheCacheFolder() {
        XCTAssertEqual(IssueCacheDirectory.safe("../etc/x"), "___etc_x")
    }

    // ── Outbox never replays across workspaces ──────────────────────────

    func testOutboxEntriesFromAAreNotReplayedIntoB() async throws {
        let clock = ManualClock()
        let outbox = Outbox(store: MemoryOutboxStore(), now: { clock.now })
        let fromA = try await outbox.enqueue(.addComment(key: "ENG-1", body: "in A"), workspaceSlug: "a")
        let fromB = try await outbox.enqueue(.addComment(key: "ENG-2", body: "in B"), workspaceSlug: "b")
        let sender = ScriptedSender()

        let inB = await outbox.drain(using: sender, workspaceSlug: "b")
        XCTAssertEqual(inB.sent, [fromB.id])
        XCTAssertEqual(sender.sent, [fromB.id], "A's entry never reached the sender while B was active")
        let left = await outbox.all
        XCTAssertEqual(left.map(\.id), [fromA.id], "A's entry waits")
        let wakeB = await outbox.nextWake(workspaceSlug: "b")
        XCTAssertNil(wakeB, "no timer for entries the active workspace cannot send")

        let backInA = await outbox.drain(using: sender, workspaceSlug: "a")
        XCTAssertEqual(backInA.sent, [fromA.id])
    }

    func testDrainWithoutWorkspaceKeepsOldBehaviour() async throws {
        let clock = ManualClock()
        let outbox = Outbox(store: MemoryOutboxStore(), now: { clock.now })
        _ = try await outbox.enqueue(.addComment(key: "ENG-1", body: "x"), workspaceSlug: "a")
        _ = try await outbox.enqueue(.addComment(key: "ENG-2", body: "y"), workspaceSlug: "b")
        let all = await outbox.drain(using: ScriptedSender())
        XCTAssertEqual(all.sent.count, 2)
    }

    // ── Capability rows ─────────────────────────────────────────────────

    func testTestNotificationOnlyWhenPushOnAndServerCanTest() throws {
        func config(_ json: String) throws -> PushConfig { try JSONDecoder().decode(PushConfig.self, from: Data(json.utf8)) }
        XCTAssertFalse(try config(#"{"enabled":false,"relayUrl":null,"serverKey":null,"canTest":false}"#).offersTest)
        XCTAssertFalse(try config(#"{"enabled":true,"relayUrl":"https://r.example.com","serverKey":"k"}"#).offersTest, "older server without the endpoint")
        XCTAssertFalse(try config(#"{"enabled":false,"relayUrl":null,"serverKey":null,"canTest":true}"#).offersTest)
        XCTAssertTrue(try config(#"{"enabled":true,"relayUrl":"https://r.example.com","serverKey":"k","canTest":true}"#).offersTest)
    }

    func testFeedbackRowOnlyInTestFlight() {
        let sandbox = URL(fileURLWithPath: "/private/var/mobile/Containers/Data/Application/X/StoreKit/sandboxReceipt")
        let store = URL(fileURLWithPath: "/private/var/mobile/Containers/Data/Application/X/StoreKit/receipt")
        XCTAssertEqual(BuildChannel.detect(receiptURL: sandbox, isDebug: false), .testFlight)
        XCTAssertEqual(BuildChannel.detect(receiptURL: store, isDebug: false), .appStore)
        XCTAssertEqual(BuildChannel.detect(receiptURL: nil, isDebug: false), .appStore)
        XCTAssertEqual(BuildChannel.detect(receiptURL: sandbox, isDebug: true), .debug)
        XCTAssertTrue(BuildChannel.testFlight.offersFeedback)
        XCTAssertFalse(BuildChannel.appStore.offersFeedback)
        XCTAssertFalse(BuildChannel.debug.offersFeedback)
    }

    func testAlternateIconsHiddenUnlessDeclared() {
        XCTAssertEqual(AlternateIcons.declared(in: nil), [])
        XCTAssertEqual(AlternateIcons.declared(in: ["CFBundleIcons": ["CFBundlePrimaryIcon": ["CFBundleIconName": "AppIcon"]]]), [])
        XCTAssertEqual(AlternateIcons.declared(in: ["CFBundleIcons": ["CFBundleAlternateIcons": ["Night": [:], "Dawn": [:]]]]), ["Dawn", "Night"])
    }
}
