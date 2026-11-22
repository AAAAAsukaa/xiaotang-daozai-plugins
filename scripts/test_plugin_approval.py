import base64
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

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
            patch.object(plugin_approval, "api", side_effect=[self.pull, {"id": 1}, {}]) as api,
            patch.object(plugin_approval, "check_submission"),
        ):
            plugin_approval.main()
        self.assertEqual(api.call_args_list[1].kwargs["data"]["head_sha"], self.head)
        self.assertEqual(api.call_args_list[2].kwargs["data"]["conclusion"], "success")

    def test_does_not_report_if_pr_head_changed_during_fetch(self):
        with (
            patch.object(plugin_approval, "git", side_effect=[b"", b"", b"new-head"]),
            patch.object(plugin_approval, "api", return_value=self.pull) as api,
            self.assertRaises(RuntimeError),
        ):
            plugin_approval.main()
        api.assert_called_once_with("repos/owner/plugins/pulls/7")


if __name__ == "__main__":
    unittest.main()
