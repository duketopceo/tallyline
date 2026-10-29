import XCTest
@testable import TallylineCore

final class PairingCodeTests: XCTestCase {
    func testPlainCodePassesThrough() {
        XCTAssertEqual(PairingCode.normalize("tlpair_abc123"), "tlpair_abc123")
    }

    func testPairURLExtractsCode() {
        XCTAssertEqual(
            PairingCode.normalize("tallyline://pair?s=https%3A%2F%2Fapi.example.com&c=tlpair_xyz"),
            "tlpair_xyz"
        )
    }

    func testSuggestedServer() {
        XCTAssertEqual(
            PairingCode.suggestedServer("tallyline://pair?s=https%3A%2F%2Fapi.example.com&c=tlpair_xyz"),
            URL(string: "https://api.example.com")
        )
        XCTAssertNil(PairingCode.suggestedServer("tlpair_abc"))
    }
}

final class APIClientURLTests: XCTestCase {
    func testPathJoinsOntoBase() {
        let client = APIClient(baseURL: URL(string: "https://api.tallyline.app")!)
        XCTAssertEqual(
            client.url(for: "/v1/whoami").absoluteString,
            "https://api.tallyline.app/v1/whoami"
        )
    }

    func testSubpathBaseIsPreserved() {
        let client = APIClient(baseURL: URL(string: "https://box.example.com/tally")!)
        XCTAssertEqual(
            client.url(for: "/v1/whoami").absoluteString,
            "https://box.example.com/tally/v1/whoami"
        )
    }

    func testQueryItems() {
        let client = APIClient(baseURL: URL(string: "https://api.tallyline.app")!)
        let url = client.url(for: "/v1/issues", query: ["updatedSince": "2026-10-01T00:00:00Z"])
        XCTAssertTrue(url.absoluteString.contains("updatedSince=2026-10-01T00:00:00Z"))
    }
}

final class CredentialTests: XCTestCase {
    func testNeedsRotationWindow() {
        let soon = DeviceCredential(
            token: "tly_pat_x", expiresAt: Date().addingTimeInterval(3600),
            deviceId: "d", userId: "u", workspaceSlug: "ws", workspaceName: "W",
            serverURL: URL(string: "https://api.tallyline.app")!
        )
        XCTAssertTrue(soon.needsRotation())
        XCTAssertFalse(soon.needsRotation(within: 60))
    }

    func testInMemoryStoreRoundTrip() throws {
        let store = InMemoryCredentialStore()
        XCTAssertNil(try store.load())
        let cred = DeviceCredential(
            token: "tly_pat_x", expiresAt: Date(), deviceId: "d", userId: "u",
            workspaceSlug: "ws", workspaceName: "W",
            serverURL: URL(string: "https://api.tallyline.app")!
        )
        try store.save(cred)
        XCTAssertEqual(try store.load()?.token, "tly_pat_x")
        try store.clear()
        XCTAssertNil(try store.load())
    }
}

final class ModelDecodingTests: XCTestCase {
    func testRedeemResponseDecodes() throws {
        let json = """
        {"token":"tly_pat_abc","expiresAt":"2027-01-01T00:00:00Z","scopes":["read","write"],
         "deviceId":"d1","userId":"u1","workspace":{"slug":"acme","name":"Acme"}}
        """.data(using: .utf8)!
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let r = try decoder.decode(PairingRedeemResponse.self, from: json)
        XCTAssertEqual(r.token, "tly_pat_abc")
        XCTAssertEqual(r.workspace.slug, "acme")
    }

    func testErrorEnvelopeDecodes() throws {
        let json = #"{"error":{"code":"BAD_CODE","message":"nope"}}"#.data(using: .utf8)!
        let e = try JSONDecoder().decode(APIErrorEnvelope.self, from: json)
        XCTAssertEqual(e.error.code, "BAD_CODE")
    }
}
