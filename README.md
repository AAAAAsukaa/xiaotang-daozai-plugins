# 岛仔插件仓

## 投稿

将插件放在 `plugins/<插件 ID>/`，提交 `plugin.json`、`main.js` 和 `cover.png`，并可附上 `README.md` 与许可证文件。插件 ID 与清单一致。封面使用 PNG，建议 16:9，大小最多 256 KiB，宽高最多 1920 × 1080。[GitHub 投稿仓](https://github.com/Renly1994/xiaotang-daozai-plugins)

在 Windows 上用岛仔的 `--plugin-test` 校验并试装，通过后向 `main` 提 PR，填写用途、版本、权限、验证方式、许可和镜像授权。每次更新递增三段式版本号并单独提交 PR。仓库 CI 检查投稿文件和版本，维护者审核行为、授权及本地运行结果。

## 反馈

从插件详情或「我的插件」打开「插件反馈」。普通问题单会按插件 ID 通知登记的维护者，安装和更新问题由仓库维护者跟进。每个新插件上架后，由仓库维护者核对并在 `.github/plugin-maintainers.json` 登记作者或接手维护的 GitHub 账号。安全或隐私问题通过 GitHub 私密报告提交。[普通问题](https://github.com/Renly1994/xiaotang-daozai-plugins/issues) · [私密报告](https://github.com/Renly1994/xiaotang-daozai-plugins/security/advisories/new)

## 发布

审核并合并后，维护者用启用了插件作者命令的岛仔构建安装包。镜像仓须已初始化默认分支，Git 使用维护者现有的 Gitee 凭据。先将现有样包发布到 `preview` 目录验收，正式上架使用 `stable` 目录。

```powershell
python scripts/publish.py example.payday --island 'D:/路径/daozai.exe' --mirror 'https://gitee.com/xiaotangtoken/xiaotang-daozai-plugins.git' --channel preview
```

发布从 GitHub `main` 读取已合并源文件，检查并上传不可覆盖的版本 ZIP。通过 Gitee 的公开 Contents API 确认 ZIP 字节一致后，再推送 `catalog.json`。同一次发布中断后可用同一版本包重试。岛仔读取同一 API 提供的索引和版本包，再核对大小与 SHA-256。[Gitee 镜像](https://gitee.com/xiaotangtoken/xiaotang-daozai-plugins) · [预览索引](https://gitee.com/api/v5/repos/xiaotangtoken/xiaotang-daozai-plugins/contents/preview/catalog.json?ref=master)

通过 Gitee 网页发布时，在命令末尾加 `--prepare 'D:/待发布/发薪倒计时'`，读取当前线上索引并导出 ZIP 和待更新索引。按输出中的 SHA-256 核对 Gitee 上可公开下载的 ZIP，再提交同目录的 `catalog.json`。
