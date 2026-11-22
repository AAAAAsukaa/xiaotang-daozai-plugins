"""用主分支的维护者登记核验投稿，并对 PR 当前提交报告结果。"""
import json
import os
from pathlib import Path
import subprocess

from submission import ROOT, changed_paths, check_pull_request, git

CHECK_NAME = "插件合并授权"


def check_submission(base, head, author, owner, comments):
    paths = changed_paths(base, head)
    plugin_paths = [path for path in paths if path.startswith("plugins/")]
    if paths and not plugin_paths and author.casefold() == owner.casefold():
        return
    if plugin_paths and len(plugin_paths) != len(paths):
        raise ValueError("请把插件投稿与仓库管理变更分成不同的 PR。")
    ids = check_pull_request(base, head, paths)
    existing = sorted(
        plugin_id for plugin_id in ids
        if git(ROOT, "ls-tree", base, "--", f"plugins/{plugin_id}")
    )
    if not existing:
        return

    maintainers = json.loads(git(ROOT, "show", f"{base}:.github/plugin-maintainers.json"))
    command = f"授权更新 {head}"
    authorized = {author.casefold()}
    for comment in comments:
        login = (comment.get("user") or {}).get("login")
        if (login and comment.get("body") == command and comment.get("created_at")
                and comment["created_at"] == comment.get("updated_at")):
            authorized.add(login.casefold())

    missing = []
    unauthorized = []
    for plugin_id in existing:
        maintainer = maintainers.get(plugin_id)
        if not isinstance(maintainer, str) or not maintainer:
            missing.append(plugin_id)
        elif maintainer.casefold() not in authorized:
            unauthorized.append(f"{plugin_id}（@{maintainer}）")
    if missing or unauthorized:
        lines = []
        if missing:
            lines.append(f"插件 {', '.join(missing)} 尚未在主分支登记维护者。")
        if unauthorized:
            lines.append(
                f"等待 {', '.join(unauthorized)} 的登记维护者授权。\n\n"
                f"请登记维护者在此 PR 新发一条评论 `{command}`。"
            )
        raise ValueError("\n\n".join(lines))


def api(path, *, token=None, method="GET", data=None, paginate=False):
    args = ["gh", "api", "--method", method, path]
    if data is not None:
        args += ["--input", "-"]
    if paginate:
        args += ["--paginate", "--slurp"]
    env = dict(os.environ, GH_TOKEN=token) if token else None
    result = subprocess.run(
        args, input=json.dumps(data) if data is not None else None,
        capture_output=True, encoding="utf-8", check=True, env=env,
    )
    return json.loads(result.stdout)


def read_comments(repo, number):
    for page in api(f"{repo}/issues/{number}/comments?per_page=100", paginate=True):
        yield from page


def main():
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
    subject = event.get("pull_request") or event.get("issue") or event.get("inputs")
    number = int(subject["number"])
    repo = f"repos/{os.environ['GITHUB_REPOSITORY']}"
    pull = api(f"{repo}/pulls/{number}")
    if pull["state"] != "open" or pull["base"]["ref"] != "main":
        return

    base, head = pull["base"]["sha"], pull["head"]["sha"]
    git(ROOT, "fetch", "--no-tags", "origin", "refs/heads/main")
    git(ROOT, "fetch", "--no-tags", "origin", f"refs/pull/{number}/head")
    if git(ROOT, "rev-parse", "FETCH_HEAD").decode().strip() != head:
        raise RuntimeError("PR 提交已变更，请使用最新的检查结果。")

    app_token = os.environ["PLUGIN_APPROVAL_TOKEN"]
    check = api(f"{repo}/check-runs", token=app_token, method="POST", data={
        "name": CHECK_NAME,
        "head_sha": head,
        "status": "in_progress",
        "external_id": str(number),
    })
    try:
        check_submission(base, head, pull["user"]["login"],
                         pull["base"]["repo"]["owner"]["login"], read_comments(repo, number))
    except ValueError as error:
        conclusion, summary = "failure", str(error)
    except subprocess.CalledProcessError:
        conclusion, summary = "failure", "无法读取投稿或授权记录，请重新运行检查。"
    else:
        conclusion, summary = "success", "投稿检查通过。"

    api(f"{repo}/check-runs/{check['id']}", token=app_token, method="PATCH", data={
        "conclusion": conclusion,
        "output": {"title": CHECK_NAME, "summary": summary},
    })


if __name__ == "__main__":
    main()
