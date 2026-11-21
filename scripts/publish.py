"""发布已合并插件，确认国内镜像能读到 ZIP 后再更新目录。"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

from submission import ROOT, git, read_plugin, version

GITEE_PATH = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
MIRROR_BRANCH = "master"
ZIP_LIMIT = 576 * 1024
CATALOG_LIMIT = 64 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def publish_origin(value):
    match = re.fullmatch(r"(https://gitee\.com/|git@gitee\.com:)([^?#]+)", value)
    if not match:
        raise ValueError("镜像须为 Gitee HTTPS 或 SSH Git 地址")
    path = match[2].removesuffix(".git")
    if not GITEE_PATH.fullmatch(path) or set(path.split("/")) & {".", ".."}:
        raise ValueError("Gitee 仓库地址无效")
    return f"https://gitee.com/api/v5/repos/{path}/contents"


def decode_public_file(record, path, limit):
    if (not isinstance(record, dict) or record.get("type") != "file"
            or record.get("path") != path or record.get("encoding") != "base64"):
        raise ValueError("Gitee 公开文件元数据无效")
    size = record.get("size")
    content = record.get("content")
    if type(size) is not int or not 0 < size <= limit or not isinstance(content, str):
        raise ValueError("Gitee 公开文件大小无效")
    encoded = content.replace("\r", "").replace("\n", "")
    if len(encoded) != (size + 2) // 3 * 4:
        raise ValueError("Gitee 公开文件长度不符")
    try:
        data = base64.b64decode(encoded, validate=True)
    except ValueError:
        raise ValueError("Gitee 公开文件编码无效") from None
    if len(data) != size:
        raise ValueError("Gitee 公开文件大小不符")
    return data


def download_public(base_url, path, limit, missing_ok=False):
    url = f"{base_url}/{urllib.parse.quote(path)}?ref={MIRROR_BRANCH}"
    # 为 Base64、换行转义及元数据留出空间，仍对整个响应限长。
    response_limit = (limit + 2) // 3 * 8 + 8192
    client = urllib.request.build_opener(NoRedirect())
    try:
        with client.open(url, timeout=8) as response:
            data = response.read(response_limit + 1)
    except urllib.error.HTTPError as error:
        if error.code == 404 and missing_ok:
            return None
        raise ValueError(f"Gitee 公开文件返回 HTTP {error.code}") from None
    except (TimeoutError, urllib.error.URLError):
        raise ValueError("无法读取 Gitee 公开文件") from None
    if len(data) > response_limit:
        raise ValueError("Gitee 公开文件响应超过大小限制")
    record = json.loads(data)
    if missing_ok and record == []:
        return None
    return decode_public_file(record, path, limit)


def verify_public_package(base_url, path, expected):
    for _ in range(6):
        try:
            if download_public(base_url, path, ZIP_LIMIT) == expected:
                return
        except ValueError:
            pass
        time.sleep(2)
    raise ValueError("Gitee 尚未提供与安装包一致的公开下载，索引保持原版本")


def git_commit_push(mirror, relative_path, message):
    git(mirror, "add", "--", relative_path)
    git(mirror, "commit", "-m", message)
    git(mirror, "push", "origin", f"HEAD:refs/heads/{MIRROR_BRANCH}")


def daozai(island, *args):
    subprocess.run([str(island), *map(str, args)], check=True)


def pack_reviewed(workspace, island, plugin_id):
    git(ROOT, "fetch", "origin", "refs/heads/main")
    commit = git(ROOT, "rev-parse", "FETCH_HEAD").decode().strip()
    manifest, files = read_plugin(ROOT, commit, plugin_id)
    source = workspace / "package"
    source.mkdir()
    for name, data in files.items():
        (source / name).write_bytes(data)
    bundle = workspace / "bundle.zip"
    daozai(island, "--plugin-pack", source / "plugin.json", bundle)
    return commit, manifest["version"], bundle


def stage_catalog(bundle, staged, original, island, plugin_id, current, data):
    if original is not None:
        previous = next(
            (entry for entry in json.loads(original)["plugins"] if entry["id"] == plugin_id),
            None,
        )
        if previous and version(previous["version"]) >= version(current):
            if (previous["version"] != current or previous["size"] != len(data)
                    or previous["sha256"] != hashlib.sha256(data).hexdigest()):
                raise ValueError("已上架版本不可覆盖，发布新包须提高版本号")
            return None
        staged.write_bytes(original)
    daozai(island, "--plugin-submit", bundle, staged)
    return staged.read_bytes()


def read_mirror_file(path, limit):
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise ValueError("镜像索引和安装包必须为普通文件")
    if path.is_file():
        if path.stat().st_size > limit:
            raise ValueError("镜像索引或安装包超出大小限制")
        return path.read_bytes()
    return None


def write_prepared(directory, name, data):
    path = directory / name
    previous = read_mirror_file(path, max(CATALOG_LIMIT, ZIP_LIMIT))
    if previous is None:
        with path.open("xb") as output:
            output.write(data)
    elif previous != data:
        raise ValueError(f"输出目录里的 {name} 内容不同，请使用新目录")


def publish(island, plugin_id, mirror_url, channel, prepare=None):
    base_url = publish_origin(mirror_url)
    with tempfile.TemporaryDirectory(prefix="daozai-market-") as temporary:
        workspace = Path(temporary)
        commit, current, bundle = pack_reviewed(workspace, island, plugin_id)
        zip_name = f"plugin-{plugin_id}-{current}.zip"
        zip_remote = f"{channel}/{zip_name}"
        catalog_remote = f"{channel}/catalog.json"
        data = bundle.read_bytes()

        if prepare is None:
            mirror = workspace / "mirror"
            git(workspace, "clone", "--quiet", "--single-branch", "--branch", MIRROR_BRANCH,
                "--", mirror_url, str(mirror))
            directory = mirror / channel
            if directory.is_symlink():
                raise ValueError("镜像目录必须为普通目录")
            directory.mkdir(exist_ok=True)
            zip_path, catalog = directory / zip_name, directory / "catalog.json"
            previous_zip = read_mirror_file(zip_path, ZIP_LIMIT)
            original = read_mirror_file(catalog, CATALOG_LIMIT)
        else:
            original = download_public(base_url, catalog_remote, CATALOG_LIMIT)
            previous_zip = download_public(base_url, zip_remote, ZIP_LIMIT, missing_ok=True)

        if previous_zip is not None and previous_zip != data:
            raise ValueError("该版本已有不同的安装包，请提高版本号")
        index = stage_catalog(bundle, workspace / "catalog.json", original, island,
                              plugin_id, current, data)
        if index is None:
            verify_public_package(base_url, zip_remote, data)
            print(f"{plugin_id} {current} 已发布")
            return

        if prepare is not None:
            prepare.mkdir(parents=True, exist_ok=True)
            write_prepared(prepare, zip_name, data)
            write_prepared(prepare, "catalog.json", index)
            print(f"{plugin_id} {current} 已准备，尚未发布")
            print(f"审定提交 {commit}")
            print(f"安装包 SHA-256 {hashlib.sha256(data).hexdigest()}")
            print(f"输出目录 {prepare}")
            return

        if previous_zip is None:
            zip_path.write_bytes(data)
            git_commit_push(mirror, zip_remote, f"同步 {plugin_id} {current} 安装包")
        verify_public_package(base_url, zip_remote, data)
        catalog.write_bytes(index)
        git_commit_push(mirror, catalog_remote, f"上架 {plugin_id} {current}")
        print(f"{plugin_id} {current} 已发布到 {channel} 目录")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plugin_id")
    parser.add_argument("--island", type=Path, required=True, help="岛仔作者命令可执行文件")
    parser.add_argument("--mirror", required=True, help="Gitee 公开镜像仓库 Git 地址")
    parser.add_argument("--channel", choices=("preview", "stable"), required=True)
    parser.add_argument("--prepare", type=Path, help="导出待发布文件的目录")
    options = parser.parse_args()
    try:
        publish(options.island.resolve(strict=True), options.plugin_id, options.mirror,
                options.channel, options.prepare)
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
