"""用主分支的维护者登记核验投稿，并对 PR 当前提交报告结果。"""
import json
import os
import subprocess
from email.utils import parsedate_to_datetime
from pathlib import Path
from time import sleep, time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

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


def retry_wait(headers, delay, rate_limited):
    after = headers.get("Retry-After")
    if after:
        try:
            seconds = int(after) if after.isdecimal() else parsedate_to_datetime(after).timestamp() - time()
        except (ValueError, TypeError, OverflowError):
            seconds = 60
        return max(delay, seconds)
    reset = headers.get("X-RateLimit-Reset", "")
    if headers.get("X-RateLimit-Remaining") == "0" and reset.isdecimal():
        return max(delay, int(reset) - time())
    return 60 * delay if rate_limited else delay


def complete_check(repo, check_id, token, conclusion, summary):
    request = Request(
        f"https://api.github.com/{repo}/check-runs/{check_id}",
        method="PATCH",
        data=json.dumps({
            "conclusion": conclusion,
            "output": {"title": CHECK_NAME, "summary": summary},
        }).encode("utf-8"),
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "daozai-plugin-approval",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    sleep(1)
    for delay in (1, 2, 4, None):
        try:
            with urlopen(request, timeout=15):
                return
        except HTTPError as error:
            with error:
                status = error.code
                headers = error.headers
                request_id = headers.get("X-GitHub-Request-Id", "未知")
                detail = f"HTTP {status}，GitHub 请求 ID {request_id}"
                rate_limited = status == 429 or (
                    status == 403 and (
                        headers.get("Retry-After")
                        or headers.get("X-RateLimit-Remaining") == "0"
                        or b"rate limit" in error.read(2048).lower()
                    )
                )
                if not (rate_limited or status in (404, 408) or 500 <= status < 600):
                    delay = None
                if delay is not None:
                    delay = retry_wait(headers, delay, rate_limited)
        except (URLError, TimeoutError) as error:
            detail = f"网络异常（{type(getattr(error, 'reason', error)).__name__}）"

        message = f"检查 {check_id} 的结论回写失败（{detail}）"
        if delay is None:
            raise RuntimeError(message) from None
        if delay > 60:
            raise RuntimeError(f"{message}，下次等待 {delay:g} 秒，超过本次重试上限。") from None
        print(f"{message}，{delay:g} 秒后自动重试。", flush=True)
        sleep(delay)


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

    complete_check(repo, check["id"], app_token, conclusion, summary)


if __name__ == "__main__":
    main()
