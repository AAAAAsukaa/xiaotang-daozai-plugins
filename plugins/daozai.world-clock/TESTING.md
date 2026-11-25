# 世界时钟验收

在本插件目录运行以下命令。宿主复现时使用 Windows 北京时间（UTC+08:00），以和固定模拟时刻一致。

```powershell
$exe = 'D:\daozai-build\worktrees\acceptance\target\x86_64-pc-windows-msvc\release\daozai.exe'
$manifest = (Resolve-Path .\plugin.json).Path
$fixture = (Resolve-Path .\fixtures\ten.json).Path
& $exe --plugin-test $manifest --input $fixture | Out-Host
node .\fixtures\test.mjs $exe
```

`fixtures/test.mjs` 校验时区、色条分段和画布布局数据，并用 `--plugin-test` 逐个比对 8 份模拟数据。只传 `node .\fixtures\test.mjs` 时运行 JavaScript 验证。

| 模拟输入 | 预期结果 |
| --- | --- |
| `default-three` | 北京、伦敦、纽约均显示，纽约工作区间拆为 00:00–07:00 和 22:00–24:00 |
| `ten` | 两排十个直径 46 的表盘和十条工作时段，全页高 344，模拟点选悉尼常驻 |
| `date-line` | 奥克兰显示「明天」，UTC−12 的时区显示「昨天」 |
| `fractional` | 新德里与加德满都分别显示 −2.5h、−2.25h，模拟点选加德满都常驻 |
| `dst-before`、`dst-after` | 纽约从 01:59 跳到 03:00，偏移从 −300 分钟切到 −240 分钟 |
| `empty`、`invalid` | 空状态提示添加城市；测试用例中的无效时区由脚本跳过，回退为首个有效城市 |

在真实宿主中，使用城市搜索添加十个城市，检查五城至六城时表盘由一排切成两排。选择「页面选中的城市」，点击表盘并检查常驻选择在刷新后保持。切到「列表第一项」后，首城显示高亮，点击其他表盘时常驻仍显示首城。切回「页面选中的城市」后恢复此前选择。指针、数字时间、表盘明暗和色条白线由宿主绑定更新。
