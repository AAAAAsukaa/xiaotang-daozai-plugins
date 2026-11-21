"""将公开反馈通知给已登记的插件维护者。"""

import json
import os
import re
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
ID_LINE = re.compile(r"^插件 ID[：:][ \t]*([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+)[ \t]*$", re.M)
LOGIN = re.compile(r"[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*")
HANDLED = "<!-- daozai-plugin-feedback -->"


def route(issue, maintainers, owner):
    title = issue.get("title") or ""
    body = (issue.get("body") or "").replace("\r\n", "\n")
    if title.startswith("[安全或隐私]") or re.search(r"^##[ \t]+安全或隐私[ \t]*$", body, re.M):
        return None
    matches = ID_LINE.findall(body)
    if len(matches) != 1 or len(matches[0]) > 64:
        return None
    login = owner if title.startswith("[安装与更新]") else maintainers.get(matches[0], owner)
    if not isinstance(login, str) or len(login) > 39 or not LOGIN.fullmatch(login):
        raise ValueError("维护者账号格式无效")
    return login


def api(path, token, data=None):
    request = Request(
        "https://api.github.com" + path,
        data=json.dumps(data, ensure_ascii=False).encode("utf-8") if data is not None else None,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "daozai-plugin-feedback",
        },
    )
    with urlopen(request, timeout=15) as response:
        return json.load(response)


def main():
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
    issue = event["issue"]
    repository = os.environ["GITHUB_REPOSITORY"]
    owner, _ = repository.split("/", 1)
    maintainers = json.loads((ROOT / ".github/plugin-maintainers.json").read_text(encoding="utf-8"))
    login = route(issue, maintainers, owner)
    if not login:
        return

    token = os.environ["GITHUB_TOKEN"]
    path = f"/repos/{repository}/issues/{int(issue['number'])}/comments"
    page = 1
    while True:
        comments = api(f"{path}?per_page=100&page={page}", token)
        if any(comment["user"]["login"] == "github-actions[bot]" and HANDLED in comment["body"]
               for comment in comments):
            return
        if len(comments) < 100:
            break
        page += 1
    api(path, token, {"body": f"{HANDLED}\n@{login} 有一条插件反馈，请查看本问题单。"})


if __name__ == "__main__":
    main()
