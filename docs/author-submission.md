# 岛仔插件作者投稿指南

准备 Windows、GitHub 账号和岛仔作者测试版。手里的岛仔如果缺少「设置 → 插件」，请先向维护者获取作者测试版。目前集市接受无外部权限的 JS 待办卡片。

## 1. 复制模板

登录 GitHub，在岛仔插件仓点 **Fork**，把仓库复制到自己的账号。用 GitHub Desktop 将自己的 fork 克隆到电脑，从最新的 `main` 新建投稿分支。[岛仔插件仓](https://github.com/Renly1994/xiaotang-daozai-plugins) · [GitHub Desktop 操作说明](https://docs.github.com/en/desktop/adding-and-cloning-repositories/cloning-and-forking-repositories-from-github-desktop?platform=windows)

把[发薪倒计时模板](../templates/payday-countdown/)的整个文件夹复制到 fork 的本地仓库，在 `plugins` 下改名为自己的插件 ID，例如 `xiaoming.payday`。最终目录如下。

```text
plugins/xiaoming.payday/
├── plugin.json
├── main.js
├── cover.png
└── LICENSE
```

- 在 `plugin.json` 里修改 `id`、`name`、`author` 和设置默认值。插件 ID 须与目录同名，至少有两个用点分隔的部分，每部分以小写字母开头，其余可用小写字母、数字和连字符，总长最多 64 字符。首版可用 `1.0.0`。
- 在 `main.js` 里修改卡片逻辑。模板的 `refresh` 读取用户设置和当天日期，返回要显示的 `card` 和要保留的 `storage`。待办卡片模板使用 `api: 1`、`runtime: "js"`、`owner: "tasks"` 和空的 `permissions`。
- 将投稿封面保存为 `cover.png`，使用与插件功能相符且有权分发的图片。封面须为 PNG，建议 16:9，最多 256 KiB，宽高最多 1920 × 1080。
- 复用模板代码时保留原来的 MIT 版权和许可。投稿可附带 `README.md`、`LICENSE` 或 `LICENSE.txt`。PR 的文件范围限定为 `plugins/<插件 ID>/` 下的允许文件。

## 2. 试装并校验

1. 在岛仔打开「设置 → 插件 → 我的插件 → 开发者模式」，点击「安装本地插件…」，选择新目录里的 `plugin.json`。
2. 回到「我的插件」启用插件。确认待办页已开启，在「待办与置物」改一次名称和日期，再打开岛上的待办页，核对卡片内容。
3. 修改源码后，选择「保留数据」卸载，再从同一个 `plugin.json` 路径安装并启用，核对原设置和新效果。
4. 在本地插件仓目录打开 PowerShell，把下例中的程序路径和插件 ID 换成自己的。看到「校验通过」且返回码为 `0` 后，把结果写进 PR。

```powershell
$island = 'D:/你的目录/daozai.exe'
$manifest = (Resolve-Path './plugins/xiaoming.payday/plugin.json').Path
& $island --plugin-test $manifest | Out-Host
$LASTEXITCODE
```

## 3. 提交 PR

1. 在 GitHub Desktop 检查变更，提交并推送投稿分支到自己的 fork。
2. 在岛仔插件仓点 **Pull requests → New pull request → compare across forks**。目标仓库选择 `Renly1994/xiaotang-daozai-plugins` 的 `main`，来源选择自己的 fork 和投稿分支。[GitHub 跨 fork 提交说明](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/creating-a-pull-request-from-a-fork)
3. 填写 PR 自带的模板，包括插件 ID、版本、功能、使用的数据及权限、试装步骤和校验结果。核对代码和封面的许可后，勾选分发授权。标题示例为「投稿：发薪倒计时 1.0.0」。
4. 查看 PR 上的校验结果和审核意见。有修改时，继续推送到这条 PR 的分支，GitHub 会更新原 PR。

合并后，维护者登记反馈接收账号，打包并同步到 Gitee，验证 ZIP 和统计登记后更新集市目录。用户打开对应频道的插件集市即可安装。

## 4. 更新已投稿的插件

1. 同步 fork 与上游的 `main`，从最新主分支新建更新分支。保留插件 ID，把版本提高到比已合入版本更高的三段式版本，例如 `1.0.0` 升到 `1.0.1`。
2. 在已有设置的测试配置中核对新版。功能不变的设置沿用原来的键和类型，数据结构保持兼容。
3. 按前面的步骤试装、校验并提交新的 PR。写明变化和旧版升级的验证结果。修复反馈时可写「关联 #编号」，上架后在原问题下回复可用版本。

<details>
<summary>在本地测试集市模拟用户更新</summary>

沿用第 2 步 PowerShell 里的 `$island` 和 `$manifest`。用一个试用配置，先将旧版提交到本地目录，从「开发者模式 → 导入测试集市目录…」选择生成的 `catalog.json`，安装、启用并保存测试设置。

```powershell
$trial = Join-Path $env:LOCALAPPDATA 'DaozaiPluginTrial/xiaoming.payday'
New-Item -ItemType Directory -Force -Path $trial | Out-Null
$version = (Get-Content -Raw -Encoding UTF8 $manifest | ConvertFrom-Json).version
$bundle = Join-Path $trial "draft-$version.zip"
$catalog = Join-Path $trial 'catalog.json'
& $island --plugin-pack $manifest $bundle | Out-Host
if ($LASTEXITCODE -eq 0) {
    & $island --plugin-submit $bundle $catalog | Out-Host
}
```

修改代码和版本后再执行一次，沿用同一个测试目录。在本地测试集市点「刷新目录」和「更新」，确认新功能生效、原设置和启用状态保留。

</details>

## 让 AI 帮忙准备投稿

把下面的提示复制给能访问本地文件和终端的 AI Agent，补上插件想法、本地 fork 路径、插件 ID、作者名、封面和岛仔作者测试版路径。已有 GitHub 登录时，也可以让 Agent 代为创建草稿 PR。

```text
请按岛仔独立插件仓的 docs/author-submission.md 帮我准备投稿。

插件要做什么：
插件 ID 和作者名：
本地 fork 路径：
岛仔作者测试版 daozai.exe 路径：
我有权使用的封面文件：
本次是首版，还是更新已有插件：

首版请从 templates/payday-countdown 复制一份到 plugins/<插件 ID>。
更新请沿用已有插件 ID，按上游版本提高版本号，并保留兼容的设置。
检查清单、代码和封面，运行岛仔的 --plugin-test，给出实际结果和手动试装步骤。
按 .github/pull_request_template.md 写好 PR 草稿，把分发授权留给我核对。
我明确让你提交时，请使用我已登录的 GitHub 账号，把投稿分支推到我的 fork，
再向 Renly1994/xiaotang-daozai-plugins 的 main 创建草稿 PR。
```
