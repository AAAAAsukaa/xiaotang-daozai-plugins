import base64
from io import BytesIO
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import call, patch
from urllib.error import HTTPError, URLError

import plugin_approval
import submission


COVER = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X8ZP8AAAAASUVORK5CYII="
)
MAINTAINERS = ".github/plugin-maintainers.json"
OWNER = "repo-owner"
ALICE_PLUGIN = "example.alpha"
BOB_PLUGIN = "example.beta"
UNREGISTERED_PLUGIN = "example.unregistered"


class PluginApprovalTests(unittest.TestCase):
    def setUp(self):
        self.repo = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(patch.object(submission, "ROOT", self.repo))
        self.enterContext(patch.object(plugin_approval, "ROOT", self.repo, create=True))
        self.git("init", "--quiet")
        self.git("config", "user.name", "Alice")
        self.git("config", "user.email", "alice@example.test")
        self.git("config", "commit.gpgsign", "false")
        self.write_maintainers({ALICE_PLUGIN: "Alice", BOB_PLUGIN: "Bob"})
        self.write_plugin(ALICE_PLUGIN, "1.0.0")
        self.write_plugin(BOB_PLUGIN, "1.0.0", "Bob")
        self.write_plugin(UNREGISTERED_PLUGIN, "1.0.0")
        self.base = self.commit()

    def git(self, *args):
        return submission.git(self.repo, *args)

    def commit(self):
        self.git("add", "--all")
        self.git("commit", "--quiet", "-m", "测试投稿")
        return self.git("rev-parse", "HEAD").decode().strip()

    def write_maintainers(self, maintainers):
        path = self.repo / MAINTAINERS
        path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps(maintainers), encoding="utf-8")

    def write_plugin(self, plugin_id, version, author="Alice"):
        directory = self.repo / "plugins" / plugin_id
        directory.mkdir(parents=True, exist_ok=True)
        manifest = {
            "id": plugin_id,
            "name": plugin_id,
            "author": author,
            "version": version,
            "api": 1,
            "runtime": "js",
            "owner": "tasks",
            "capabilities": ["card"],
            "entry": "main.js",
            "cover": "cover.png",
            "permissions": {},
        }
        (directory / "plugin.json").write_text(json.dumps(manifest), encoding="utf-8")
        (directory / "main.js").write_text(f"// {version}\n", encoding="utf-8")
        (directory / "cover.png").write_bytes(COVER)

    def authorization(self, login, head):
        timestamp = "2026-11-22T09:00:00Z"
        return {
            "body": f"授权更新 {head}",
            "user": {"login": login},
            "created_at": timestamp,
            "updated_at": timestamp,
        }

    def check(self, head, author, *comments):
        plugin_approval.check_submission(self.base, head, author, OWNER, list(comments))

    def test_new_plugin_uses_existing_submission_validation(self):
        self.write_plugin("example.new", "1.0.0")
        self.check(self.commit(), "contributor")

    def test_registered_maintainer_can_submit_their_own_update(self):
        self.write_plugin(ALICE_PLUGIN, "1.1.0")
        self.check(self.commit(), "alice")

    def test_shortcut_asset_submission_and_update_respect_ownership(self):
        plugin_id = "example.shortcuts"
        self.write_plugin(plugin_id, "1.0.0")
        directory = self.repo / "plugins" / plugin_id
        manifest_path = directory / "plugin.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest.update(runtime="assets", owner="pages", entry="shortcuts.json",
                        dataVersion=1, settings=[], capabilities=["navigation.shortcuts"])
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        (directory / "main.js").unlink()
        (directory / "shortcuts.json").write_text('{"colors":{"tasks":"#123456"}}', encoding="utf-8")
        self.check(self.commit(), "contributor")

        self.write_maintainers({plugin_id: "Alice"})
        self.base = self.commit()
        manifest["version"] = "1.0.1"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        head = self.commit()
        with self.assertRaises(ValueError):
            self.check(head, "contributor")
        self.check(head, "contributor", self.authorization("Alice", head))

    def test_author_field_commit_author_and_repository_owner_cannot_substitute(self):
        self.write_plugin(ALICE_PLUGIN, "1.1.0", "Alice")
        head = self.commit()
        for author in ("contributor", OWNER):
            with self.subTest(author=author), self.assertRaises(ValueError):
                self.check(head, author, self.authorization(OWNER, head))

    def test_registered_maintainer_can_authorize_current_head(self):
        self.write_plugin(ALICE_PLUGIN, "1.1.0")
        head = self.commit()
        self.check(head, "contributor", self.authorization("aLiCe", head))

    def test_authorization_does_not_carry_to_a_new_head(self):
        self.write_plugin(ALICE_PLUGIN, "1.1.0")
        authorization = self.authorization("Alice", self.commit())
        self.write_plugin(ALICE_PLUGIN, "1.2.0")
        with self.assertRaises(ValueError):
            self.check(self.commit(), "contributor", authorization)

    def test_only_a_new_explicit_comment_counts_as_authorization(self):
        self.write_plugin(ALICE_PLUGIN, "1.1.0")
        head = self.commit()
        authorization = self.authorization("Alice", head)
        comments = [
            dict(authorization, body="通过"),
            dict(authorization, updated_at="2026-11-22T09:01:00Z"),
            dict(authorization, body=f"> 授权更新 {head}"),
        ]
        for comment in comments:
            with self.subTest(comment=comment), self.assertRaises(ValueError):
                self.check(head, "contributor", comment)

    def test_each_existing_plugin_needs_its_maintainers_authorization(self):
        self.write_plugin(ALICE_PLUGIN, "1.1.0")
        self.write_plugin(BOB_PLUGIN, "1.1.0", "Bob")
        head = self.commit()
        alice = self.authorization("Alice", head)
        bob = self.authorization("Bob", head)
        with self.assertRaises(ValueError):
            self.check(head, "contributor", alice)
        self.check(head, "contributor", alice, bob)
        self.check(head, "Alice", bob)

    def test_existing_plugin_without_registered_maintainer_cannot_update(self):
        self.write_plugin(UNREGISTERED_PLUGIN, "1.1.0")
        head = self.commit()
        with self.assertRaises(ValueError):
            self.check(head, "Alice", self.authorization("Alice", head))

    def test_repository_owner_can_update_maintainer_registry_separately(self):
        self.write_maintainers({ALICE_PLUGIN: OWNER, BOB_PLUGIN: "Bob"})
        head = self.commit()
        self.check(head, OWNER)
        with self.assertRaises(ValueError):
            self.check(head, "contributor")

    def test_repository_owner_cannot_mix_registry_change_with_plugin_update(self):
        self.write_maintainers({ALICE_PLUGIN: OWNER, BOB_PLUGIN: "Bob"})
        self.write_plugin(ALICE_PLUGIN, "1.1.0")
        head = self.commit()
        with self.assertRaises(ValueError):
            self.check(head, OWNER, self.authorization("Alice", head))


class PluginApprovalReportingTests(unittest.TestCase):
    def setUp(self):
        directory = Path(self.enterContext(tempfile.TemporaryDirectory()))
        event = directory / "event.json"
        event.write_text('{"pull_request":{"number":7}}', encoding="utf-8")
        self.enterContext(patch.dict(os.environ, {
            "GITHUB_EVENT_PATH": str(event),
            "GITHUB_REPOSITORY": "owner/plugins",
            "PLUGIN_APPROVAL_TOKEN": "test-token",
        }))
        self.head = "a" * 40
        self.pull = {
            "state": "open",
            "base": {"ref": "main", "sha": "b" * 40, "repo": {"owner": {"login": OWNER}}},
            "head": {"sha": self.head},
            "merge_commit_sha": "c" * 40,
            "user": {"login": "contributor"},
        }

    def test_reports_the_verified_head_instead_of_the_test_merge_commit(self):
        with (
            patch.object(plugin_approval, "git", side_effect=[b"", b"", self.head.encode()]),
            patch.object(plugin_approval, "api", side_effect=[self.pull, {"id": 1}]) as api,
            patch.object(plugin_approval, "check_submission"),
            patch.object(plugin_approval, "complete_check") as complete,
        ):
            plugin_approval.main()
        self.assertEqual(api.call_args_list, [
            call("repos/owner/plugins/pulls/7"),
            call("repos/owner/plugins/check-runs", token="test-token", method="POST", data={
                "name": plugin_approval.CHECK_NAME,
                "head_sha": self.head,
                "status": "in_progress",
                "external_id": "7",
            }),
        ])
        complete.assert_called_once_with("repos/owner/plugins", 1, "test-token", "success", "投稿检查通过。")

    def test_does_not_report_if_pr_head_changed_during_fetch(self):
        with (
            patch.object(plugin_approval, "git", side_effect=[b"", b"", b"new-head"]),
            patch.object(plugin_approval, "api", return_value=self.pull) as api,
            self.assertRaises(RuntimeError),
        ):
            plugin_approval.main()
        api.assert_called_once_with("repos/owner/plugins/pulls/7")


class PluginApprovalCompletionTests(unittest.TestCase):
    url = "https://api.github.com/repos/owner/plugins/check-runs/1"

    def setUp(self):
        self.urlopen = self.enterContext(patch.object(plugin_approval, "urlopen"))
        self.sleep = self.enterContext(patch.object(plugin_approval, "sleep"))
        self.enterContext(patch("builtins.print"))

    def http_error(self, status, **headers):
        headers = {"X-GitHub-Request-Id": "test-request", **headers}
        return HTTPError(self.url, status, "测试响应", headers, BytesIO(b"raw response"))

    def complete(self):
        plugin_approval.complete_check("repos/owner/plugins", 1, "test-token", "failure", "等待维护者授权。")

    def test_resends_the_same_check_result_after_not_found_and_server_error(self):
        self.urlopen.side_effect = [self.http_error(404), self.http_error(503), self.urlopen.return_value]

        self.complete()

        request = self.urlopen.call_args.args[0]
        self.assertEqual(self.urlopen.call_args_list, [call(request, timeout=15)] * 3)
        self.assertEqual(self.sleep.call_args_list, [call(1), call(1), call(2)])
        self.assertEqual(request.full_url, self.url)
        self.assertEqual(request.get_method(), "PATCH")
        self.assertEqual(json.loads(request.data), {
            "conclusion": "failure",
            "output": {"title": plugin_approval.CHECK_NAME, "summary": "等待维护者授权。"},
        })

    def test_waits_for_retry_after_when_rate_limited(self):
        self.urlopen.side_effect = [self.http_error(429, **{"Retry-After": "12"}), self.urlopen.return_value]

        self.complete()

        self.assertEqual(self.urlopen.call_count, 2)
        self.assertEqual(self.sleep.call_args_list, [call(1), call(12)])

    def test_retries_network_timeout(self):
        self.urlopen.side_effect = [URLError(TimeoutError()), self.urlopen.return_value]

        self.complete()

        self.assertEqual(self.urlopen.call_count, 2)
        self.assertEqual(self.sleep.call_args_list, [call(1), call(1)])

    def test_does_not_retry_authentication_permission_or_validation_errors(self):
        for status in (401, 403, 422):
            with self.subTest(status=status):
                self.urlopen.reset_mock()
                self.sleep.reset_mock()
                self.urlopen.side_effect = self.http_error(status)

                with self.assertRaisesRegex(RuntimeError, rf"HTTP {status}.*test-request") as error:
                    self.complete()

                self.urlopen.assert_called_once()
                self.sleep.assert_called_once_with(1)
                self.assertNotIn("test-token", str(error.exception))
                self.assertNotIn("raw response", str(error.exception))

    def test_stops_after_three_retries(self):
        self.urlopen.side_effect = [self.http_error(404) for _ in range(4)]

        with self.assertRaisesRegex(RuntimeError, "HTTP 404.*test-request"):
            self.complete()

        self.assertEqual(self.urlopen.call_count, 4)
        self.assertEqual(self.sleep.call_args_list, [call(1), call(1), call(2), call(4)])


if __name__ == "__main__":
    unittest.main()
