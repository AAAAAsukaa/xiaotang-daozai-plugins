"""从 Git 对象读取投稿并做静态检查。"""
import json
from pathlib import Path
import re
import struct
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PLUGIN_ID = re.compile(r"[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+")
VERSION = re.compile(r"(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){2}")
PACKAGE_FILES = {
    "plugin.json": 32 * 1024,
    "main.js": 256 * 1024,
    "shortcuts.json": 4 * 1024,
    "cover.png": 256 * 1024,
}
SHORTCUT_PAGES = {
    "music", "focus", "health", "shelf", "tasks", "mail", "quota", "calendar",
    "weather", "performance", "wireless",
}
SHORTCUT_COLOR = re.compile(r"#[0-9A-Fa-f]{6}")
OPTIONAL_FILES = {"README.md", "LICENSE", "LICENSE.txt"}


def git(repo, *args):
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=True, stdout=subprocess.PIPE,
    ).stdout


def version(value):
    if not isinstance(value, str) or len(value) > 32 or not VERSION.fullmatch(value):
        raise ValueError("版本号必须为 major.minor.patch")
    numbers = tuple(map(int, value.split(".")))
    if max(numbers) > 2**32 - 1:
        raise ValueError("版本号超出支持范围")
    return numbers


def check_cover(cover):
    if (len(cover) < 45 or not cover.startswith(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR")
            or not cover.endswith(b"\0\0\0\0IEND\xaeB`\x82")):
        raise ValueError("封面必须为完整的 PNG 图片")
    width, height = struct.unpack(">II", cover[16:24])
    if not (0 < width <= 1920 and 0 < height <= 1080):
        raise ValueError("封面尺寸必须小于或等于 1920 × 1080")


def check_shortcuts(raw):
    data = json.loads(raw.decode("utf-8"))
    if not isinstance(data, dict) or data.keys() != {"colors"}:
        raise ValueError("shortcuts.json 必须只包含 colors")
    colors = data["colors"]
    if not isinstance(colors, dict) or not colors or colors.keys() - SHORTCUT_PAGES:
        raise ValueError("请至少为一个已知功能页设置配色")
    if any(not isinstance(color, str) or not SHORTCUT_COLOR.fullmatch(color) for color in colors.values()):
        raise ValueError("快捷切换配色必须使用 #RRGGBB 格式")


def read_plugin(repo, commit, plugin_id):
    if len(plugin_id) > 64 or not PLUGIN_ID.fullmatch(plugin_id):
        raise ValueError(f"插件 ID 无效：{plugin_id}")
    prefix = f"plugins/{plugin_id}/"
    records = git(repo, "ls-tree", "-rz", commit, "--", prefix).split(b"\0")
    files = {}
    for record in filter(None, records):
        header, path = record.split(b"\t", 1)
        mode, _, oid = header.decode().split()
        name = path.decode().removeprefix(prefix)
        if mode != "100644" or name not in PACKAGE_FILES.keys() | OPTIONAL_FILES:
            raise ValueError(f"插件目录出现未支持的文件：{prefix}{name}")
        limit = PACKAGE_FILES.get(name, 64 * 1024)
        if int(git(repo, "cat-file", "-s", oid)) > limit:
            raise ValueError(f"{prefix}{name} 超出大小限制")
        if name in PACKAGE_FILES:
            files[name] = git(repo, "cat-file", "blob", oid)
    if missing := {"plugin.json", "cover.png"} - files.keys():
        raise ValueError(f"{plugin_id} 缺少文件：{', '.join(sorted(missing))}")
    manifest = json.loads(files["plugin.json"].decode("utf-8"))
    if not isinstance(manifest, dict) or manifest.get("id") != plugin_id:
        raise ValueError(f"清单 ID 必须与目录 {plugin_id} 一致")
    version(manifest.get("version"))
    for field in ("name", "author"):
        value = manifest.get(field)
        if not isinstance(value, str) or not value.strip() or len(value) > 80:
            raise ValueError(f"清单 {field} 必须为 1 至 80 字符的非空名称")
    required = {"api": 1, "cover": "cover.png", "permissions": {}}
    if manifest.get("runtime") == "assets":
        entry = "shortcuts.json"
        required.update(runtime="assets", owner="pages", entry=entry, dataVersion=1,
                        settings=[], capabilities=["navigation.shortcuts"])
    else:
        entry = "main.js"
        required.update(runtime="js", owner="tasks", entry=entry)
    for key, value in required.items():
        if type(manifest.get(key)) is not type(value) or manifest[key] != value:
            raise ValueError(f"清单 {key} 与 {entry} 对应的插件格式不符")
    if entry not in files:
        raise ValueError(f"{plugin_id} 缺少文件：{entry}")
    if extra := files.keys() - {"plugin.json", "cover.png", entry}:
        raise ValueError(f"{plugin_id} 出现未使用的入口：{', '.join(sorted(extra))}")
    if entry == "shortcuts.json":
        check_shortcuts(files[entry])
    elif not files[entry].decode("utf-8").strip():
        raise ValueError("main.js 不能为空")
    check_cover(files["cover.png"])
    return manifest, files


def changed_paths(base, head):
    fork = git(ROOT, "merge-base", base, head).decode().strip()
    changed = git(ROOT, "diff", "--name-only", "-z", "--no-renames", fork, head)
    return list(filter(None, changed.decode().split("\0")))


def check_pull_request(base, head, paths=None):
    ids = set()
    if paths is None:
        paths = changed_paths(base, head)
    for path in paths:
        parts = path.split("/")
        if len(parts) != 3 or parts[0] != "plugins":
            raise ValueError(f"投稿 PR 只能修改插件目录：{path}")
        ids.add(parts[1])
    if not ids:
        raise ValueError("投稿 PR 未包含插件变更")
    for plugin_id in sorted(ids):
        manifest, _ = read_plugin(ROOT, head, plugin_id)
        if git(ROOT, "ls-tree", base, "--", f"plugins/{plugin_id}"):
            previous, _ = read_plugin(ROOT, base, plugin_id)
            if version(manifest["version"]) <= version(previous["version"]):
                raise ValueError(f"{plugin_id} 必须提交高于主分支的版本")
        print(f"{plugin_id} {manifest['version']} 静态检查通过")
    return ids


if __name__ == "__main__":
    try:
        check_pull_request(*sys.argv[1:])
    except (ValueError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
