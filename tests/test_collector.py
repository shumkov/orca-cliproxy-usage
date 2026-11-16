import importlib.util
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("collector", Path(__file__).parents[1] / "src/collector.py")
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)


class CollectorTests(unittest.TestCase):
    def test_missing_observation_is_unknown_and_relative_reset_does_not_move(self):
        quota = {"signals": {"X-Codex-Primary-Used-Percent": "21", "X-Codex-Primary-Window-Minutes": "10080", "X-Codex-Primary-Reset-After-Seconds": "60"}}
        self.assertEqual(collector.signal_windows(quota, "codex"), [])
        quota["observed_at"] = "2026-11-15T10:00:00Z"
        window = collector.signal_windows(quota, "codex")[0]
        self.assertEqual(window["resetAt"], 1794736860000)
        self.assertEqual(window["usedPercent"], 21)
        quota["signals"]["X-Codex-Secondary-Window-Minutes"] = "0"
        self.assertEqual(len(collector.signal_windows(quota, "codex")), 1)

    def test_redaction_and_model_cooldown_do_not_disable_whole_credential(self):
        entry = {"name": "<img src=x onerror=alert(1)>", "auth_index": "a", "provider": "claude", "status": "active", "disabled": False,
                 "id_token": "SECRET", "access_token": "SECRET", "status_message": "SECRET", "cooldowns": [{"scope": "model", "model_key": "opus", "reason": "quota", "retry_at": "2026-11-17T08:00:00Z"}]}
        account = collector.normalize(entry)
        self.assertTrue(account["available"])
        self.assertNotIn("SECRET", json.dumps(account))
        self.assertEqual(account["cooldowns"][0]["scope"], "model")
        entry["cooldowns"].append({"scope": "credential"})
        self.assertFalse(collector.normalize(entry)["available"])

    def test_rich_windows_keep_unknown_and_plan_labels(self):
        value = collector.normalize_rich("codex", {"usage": {"plan_type": "promax", "rate_limit": {"primary_window": {"used_percent": 8, "limit_window_seconds": 604800, "reset_after_seconds": 90}, "secondary_window": {"used_percent": 0, "limit_window_seconds": 0}}}, "resets": {"available_count": 2, "credits": [{"expires_at": "2026-11-20T00:00:00Z"}]}}, 100000)
        self.assertEqual(value["plan"], "Pro 500")
        self.assertEqual(value["windows"][0]["resetAt"], 190000)
        self.assertEqual(value["resetEntitlements"]["available"], 2)
        self.assertEqual(len(value["windows"]), 1)

    def test_unknown_or_blocked_state_never_claims_availability(self):
        entry = {"name": "fixture", "auth_index": "a", "provider": "claude", "disabled": False, "status": "active"}
        self.assertTrue(collector.normalize(entry)["available"])
        for blocker in ("disabled", "requires_sign_in", "quota_blocked", "unavailable"):
            self.assertFalse(collector.normalize(dict(entry, **{blocker: True}))["available"])
        for status in (None, "unknown", "error", "disabled"):
            self.assertFalse(collector.normalize(dict(entry, status=status))["available"])

    def test_loopback_parser_rejects_redirectable_routes_and_credentials(self):
        for value in ("http://example.com:8318", "http://user:secret@127.0.0.1:8318", "http://127.0.0.1:8318/a", "http://127.0.0.1:8318?x=1", "http://127.0.0.1:8318#x"):
            with self.assertRaises(collector.Failure):
                collector.validate_base(value)

    def test_credential_cooldown_beyond_display_limit_still_blocks_availability(self):
        entry = {"name": "fixture", "auth_index": "a", "provider": "claude", "disabled": False, "status": "active", "cooldowns": [{"scope": "model"}] * 100 + [{"scope": "credential"}]}
        self.assertFalse(collector.normalize(entry)["available"])

    def test_reset_expiries_exclude_consumed_entitlements(self):
        value = collector.normalize_rich("codex", {"resets": {"available_count": 1, "credits": [
            {"reset_type": "codex_rate_limits", "status": "available", "expires_at": "2026-11-20T00:00:00Z"},
            {"reset_type": "codex_rate_limits", "status": "consumed", "expires_at": "2026-11-21T00:00:00Z"},
        ]}}, 1000)
        self.assertEqual(len(value["resetEntitlements"]["expiresAt"]), 1)


class ManagementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.state_path = Path(self.temp.name) / "state.json"
        self.state_path.write_text(json.dumps({"disabled": False}))
        self.patch_count = 0
        self.calls = []
        self.reject = False
        self.lost = False
        self.nested_status = 200
        self.redirect = False
        self.outer_relay_status = 200
        self.provider_body = {"plan_type": "pro", "id_token": "DO_NOT_LEAK"}
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                outer.calls.append(("GET", self.path))
                if outer.redirect:
                    self.send_response(302)
                    self.send_header("Location", "/secret-target")
                    self.end_headers()
                    return
                if outer.reject:
                    self.send_response(401)
                    self.end_headers()
                    return
                body = {"files": [{"name": "fixture.json", "auth_index": "fixture", "provider": "codex", "status": "active", "disabled": json.loads(outer.state_path.read_text())["disabled"], "id_token": "DO_NOT_LEAK"}]}
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps(body).encode())

            def do_PATCH(self):
                outer.patch_count += 1
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                outer.state_path.write_text(json.dumps({"disabled": body["disabled"]}))
                if outer.lost:
                    self.close_connection = True
                    return
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"{}")

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                outer.calls.append(("POST", body))
                self.send_response(outer.outer_relay_status)
                self.end_headers()
                self.wfile.write(json.dumps({"status_code": outer.nested_status, "header": {"Retry-After": ["120"]}, "body": json.dumps(outer.provider_body)}).encode())

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        config = Path(self.temp.name) / "config.yaml"
        config.write_text(json.dumps({"remote-management": {"secret-key": "fixture-secret"}}))
        self.profile = {"configPath": str(config), "baseUrl": "http://127.0.0.1:%d" % self.server.server_port}

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    def test_enabled_is_verified_from_durable_server_state(self):
        result = collector.collect({"profile": self.profile, "operation": "toggle", "identity": {"name": "fixture.json", "authIndex": "fixture"}, "disabled": True})
        self.assertEqual(result["mutation"], "confirmed")
        self.assertTrue(json.loads(self.state_path.read_text())["disabled"])
        self.assertTrue(collector.collect({"profile": self.profile, "operation": "read"})["accounts"][0]["disabled"])
        self.assertEqual(self.patch_count, 1)

    def test_applied_patch_lost_response_is_reconciled_without_second_patch(self):
        self.lost = True
        result = collector.collect({"profile": self.profile, "operation": "toggle", "identity": {"name": "fixture.json", "authIndex": "fixture"}, "disabled": True})
        self.assertEqual(result["mutation"], "confirmed")
        self.assertEqual(self.patch_count, 1)
        self.assertTrue(json.loads(self.state_path.read_text())["disabled"])

    def test_nested_auth_error_is_not_outer_rejection_and_stops_credential_reads(self):
        self.nested_status = 401
        result = collector.collect({"profile": self.profile, "operation": "rich", "identity": {"name": "fixture.json", "authIndex": "fixture"}})
        self.assertNotIn("authRejected", result)
        self.assertEqual(result["rich"]["error"], "Provider authentication rejected (401)")
        self.assertEqual(len([x for x in self.calls if x[0] == "POST"]), 1)
        self.assertNotIn("DO_NOT_LEAK", json.dumps(result))

    def test_outer_auth_rejection_has_no_retry(self):
        self.reject = True
        result = collector.collect({"profile": self.profile, "operation": "read"})
        self.assertTrue(result["authRejected"])
        self.assertEqual(len(self.calls), 1)

    def test_rich_uses_only_fixed_get_relay(self):
        result = collector.collect({"profile": self.profile, "operation": "rich", "identity": {"name": "fixture.json", "authIndex": "fixture"}})
        relays = [x[1] for x in self.calls if x[0] == "POST"]
        self.assertEqual(len(relays), 2)
        self.assertTrue(all(x["method"] == "GET" and x["authIndex"] == "fixture" for x in relays))
        self.assertTrue(all("consume" not in x["url"] for x in relays))
        self.assertNotIn("DO_NOT_LEAK", json.dumps(result))

    def test_http_redirect_is_refused_without_forwarding_authorization(self):
        self.redirect = True
        result = collector.collect({"profile": self.profile, "operation": "read"})
        self.assertEqual(result["error"], "Management HTTP 302")
        self.assertEqual(self.calls, [("GET", "/v8/management/credentials")])

    def test_stale_identity_never_mutates_another_entry(self):
        result = collector.collect({"profile": self.profile, "operation": "toggle", "identity": {"name": "fixture.json", "authIndex": "different"}, "disabled": True})
        self.assertEqual(result["code"], "stale")
        self.assertEqual(self.patch_count, 0)

    def test_provider_retry_after_is_propagated_without_repeated_gets(self):
        self.nested_status = 429
        result = collector.collect({"profile": self.profile, "operation": "rich", "identity": {"name": "fixture.json", "authIndex": "fixture"}})
        self.assertGreater(result["rich"]["retryAt"], 0)
        self.assertEqual(len([x for x in self.calls if x[0] == "POST"]), 1)

    def test_outer_relay_failure_invalidates_connection_instead_of_fresh_success(self):
        self.outer_relay_status = 503
        result = collector.collect({"profile": self.profile, "operation": "rich", "identity": {"name": "fixture.json", "authIndex": "fixture"}})
        self.assertEqual(result.get("code"), "http")
        self.assertNotIn("observedAt", result)

    def test_malformed_provider_plan_is_a_credential_error_not_a_lost_snapshot(self):
        self.provider_body = {"plan_type": {"unexpected": "DO_NOT_LEAK"}}
        result = collector.collect({"profile": self.profile, "operation": "rich", "identity": {"name": "fixture.json", "authIndex": "fixture"}})
        self.assertEqual(len(result.get("accounts", [])), 1)
        self.assertIn("error", result["rich"])
        self.assertNotIn("DO_NOT_LEAK", json.dumps(result))

    def test_outer_auth_rejection_during_relay_stops_all_remaining_requests(self):
        self.outer_relay_status = 401
        result = collector.collect({"profile": self.profile, "operation": "rich", "identity": {"name": "fixture.json", "authIndex": "fixture"}})
        self.assertTrue(result.get("authRejected"))
        self.assertEqual(len([x for x in self.calls if x[0] == "POST"]), 1)


if __name__ == "__main__":
    unittest.main()
