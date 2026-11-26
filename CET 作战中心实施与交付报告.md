# CET 作战中心实施与交付报告

整理日期为 2026 年 11 月 27 日。本报告记录 Codex 在本次 StudyHack 界面升级中实际编写或修改的文件、复用的项目文件、实现方法、测试和交付产物。代码与媒体通过对应文件链接查阅。

## 1. 工作目录与版本

| 项目 | 位置与状态 |
| --- | --- |
| Qoder 原项目 | `C:\Users\Leo18\OneDrive\Desktop\cet-handoff\cet-studyhack-lab`。Qoder 在此独立实现和验收。 |
| Codex 实现副本 | `C:\Users\Leo18\OneDrive\Desktop\cet-handoff\cet-studyhack-command-edition`。本地包含五轴战绩雷达、四层 3D 沙盘、全站科技模式和简约模式。 |
| GitHub 已上传版本 | `Coffeelake14/cethandoff` 的 `codex/cet-command-award` 分支，提交 `c38c732`。该提交包含五轴雷达和当时的沙盘，后续四层底座和全站双模式是本地增量。 [GitHub 分支](https://github.com/Coffeelake14/cethandoff/tree/codex/cet-command-award) |
| 最新 Codex 增量 | [CET Full 3D Workbench.patch](<CET Full 3D Workbench.patch>)，以 `c38c732` 的目录结构为基线，包含已验收的四层底座和全站双模式。生成时通过 `git apply --cached --check`。 |

当时直接推送 `main` 被远程拒绝，因为远程已有本地尚未同步的提交，因此把 `c38c732` 推送到了独立分支。GitHub 上传的是代码快照，截图与录屏保存在本地副本。

## 2. Codex 编写和修改的源文件

下表中的相对路径均以 `cet-studyhack-command-edition` 为根目录。已有文件的角色与本轮变化同时列出，便于对照提交历史。

| 文件 | 本轮实际工作 |
| --- | --- |
| [web/index.html](cet-studyhack-command-edition/web/index.html) | 重排作战中心标题、三栏、图谱图例与当前目标。加入展开分层控制、雷达容器、阅读与估分仪器挂载点、总分刻度盘和双模式入口。 |
| [web/command.css](cet-studyhack-command-edition/web/command.css) | 定义作战台材质、玻璃与金属面、沙盘投影面、轨道、准星、脉冲、四层底座和移动布局。 |
| [web/command-graph.js](cet-studyhack-command-edition/web/command-graph.js) | 在已有图谱上叠加分层球体、投影网格、四层实体底座与支架，增加分层展开动画和复位。修正窄屏取景及重绘后的键盘焦点。 |
| [web/command.js](cet-studyhack-command-edition/web/command.js) | 把五轴雷达接到历史刷新，简化界面文案，补充当前节点最近一次的依据状态，将答题脉冲联动到雷达、详情和日志。 |
| [web/command-radar.js](cet-studyhack-command-edition/web/command-radar.js) | 新增五轴数据计算、SVG 绘制、可键盘选择的轴按钮和详细读数。 |
| [web/command-radar.css](cet-studyhack-command-edition/web/command-radar.css) | 新增雷达刻度、待测与实测样式、图形高亮和读数布局，后续改为嵌入式石墨仪表。 |
| [web/shell.js](cet-studyhack-command-edition/web/shell.js) | 分开维护当前功能页和当前视觉模式。打开作战中心使用科技模式，阅读与估分可在当前页切换，并更新按钮文案和焦点。 |
| [web/app.js](cet-studyhack-command-edition/web/app.js) | 将新增仪器的初始化接入原入口。 |
| [web/workbench.js](cet-studyhack-command-edition/web/workbench.js) | 新增三类 CSS 3D 仪器的几何参数、面片挂载和鼠标视差处理。 |
| [web/workbench.css](cet-studyhack-command-edition/web/workbench.css) | 新增仅在科技模式显示的材质、机械按键、阶段装配、证据对照、结果扫描、立体估分盘和窄屏样式。 |
| [web/lab.js](cet-studyhack-command-edition/web/lab.js) | 为当前练习阶段增加样式挂钩和装配件，通过现有页面状态触发动效。 |
| [web/estimator.js](cet-studyhack-command-edition/web/estimator.js) | 用实际总分驱动 3D 刻度盘的角度。原估分公式继续来自已有模块。 |
| [dev/accept-command.mjs](cet-studyhack-command-edition/dev/accept-command.mjs) | 在已有 Chrome 验收脚本中补充雷达、四层底座、模式切换和带后端的阅读工具检查。修正 CDP 的 Enter 事件及拖动断言，更新桌面与手机截图。 |

早期还在隔离浏览器中制作了两文件续跑补丁，目标是原项目中的 `web/command-graph.js` 和 `dev/accept-command.mjs`。该补丁在临时环境中验证，随后用于建立 Codex 副本。Qoder 独立实现阶段使用的是它自己在原项目中的改动。

## 3. 创建副本时复用的文件

下面这些文件也随副本进入 `c38c732`，来自建立副本时已有的项目内容。此处列出它们以便通过提交核对来源。

| 位置 | 文件 |
| --- | --- |
| 项目根目录 | `.gitignore`、`schema.sql`、`交接说明.md`、`部署交接说明.md` |
| `web/` | `command-history.js`、`engine.js`、`lab-data.js`、`lab.css`、`markdown.js`、`reading.js`、`sample.js`、`scan.js`、`sse.mjs`、`styles.css` |
| `functions/` | `cloud-agents.mjs`、`corpus.mjs`、`gate.mjs`、`handler.mjs`、`index.ts`、`lab-bank.mjs`、`prompt.mjs`、`quota.mjs`、`rag.mjs`、`resources.mjs`、`sse.mjs`、`visitor.mjs` |
| `dev/` | `accept-live.mjs`、`fake-cloud.mjs`、`fixture.mjs`、`live-vision.mjs`、`server.mjs`、`test-command-history.mjs`、`test-engine.mjs`、`test-flow.mjs`、`test-gate.mjs`、`test-handler.mjs`、`test-lab.mjs`、`test-quota.mjs`、`test-resources.mjs`、`tmp-geo.mjs` |

`tmp-geo.mjs` 是已有的临时几何探针。建立副本时保留了运行所需目录，并沿用原生 HTML、CSS、JavaScript 和 Node.js 本地服务。正式 Qoder 站点的绑定只存在于原项目。

## 4. 实现方法

### 沙盘和 3D 材质

`project()` 先对三维坐标应用水平和垂直旋转，再根据深度投影到画布。节点前后有不同视差，鼠标释放后短暂缓动。`wireSphere()` 把球面网格拆成近处与远处线段，采用不同亮度，配合透视地面与分段环形支架建立纵深。

`machineDeck()` 将每层的轮廓投影成顶面和可见侧壁。四层分别使用暗色底座、铜夹层、金属面和半透上层。展开时上层按层号拉开，复位恢复角度与层距。手机取景提高装置中心并缩小底座，使它在视口内完整显示。

视觉上将大面积蓝色换成石墨和暖灰，以顶面、侧壁、边缘高光区分深度。薄荷色用于读数与焦点，铜橙色用于错因反馈和夹层。移除装饰星点和部分重复轨道，缩短页头和节点说明，把注意力留给练习入口、沙盘和雷达。

### 数据、雷达和反馈

代码沿用 `command-history.js` 的本地历史。主练习和同类题分开记录，重复提交按记录键去重，历史最多保留 100 条。判断正确与判断依据分别采用各自的可判定条件。

| 雷达轴 | 依据 |
| --- | --- |
| 首答 | 可判定的主练习中，首答正确次数除以可判定次数 |
| 依据 | 可判断证据的主练习中，首答证据对齐次数除以可判断次数 |
| 重答 | 首答错误且确实做过重答的可判定练习中，重答纠错次数除以可判定次数 |
| 同类答题 | 可判定的同类题中，答对次数除以可判定次数 |
| 同类依据 | 可判断证据的同类题中，证据对齐次数除以可判断次数 |

`0/1` 是实测未命中，`—` 是暂无样本。有足够样本时生成闭合轮廓，部分样本只连接相邻的实测点。点击或按 Enter 可查看对应轴的命中数和分母。首答进入短提示后暂缓入历史，正式揭晓后才产生新记录。首次新记录以记录键驱动一轮脉冲，同步更新右侧详情和日志，刷新和普通导航不会重复播报。

### 全站双模式和仪器

科技模式与简约模式共用页面、表单和浏览器中的作答状态。模式切换在现有 DOM 上改变显示状态，已选答案、证据、草稿和估分输入继续使用原来的数据。

- **错因实验室**使用分层实验仪器、装配片和带厚度的机械按键。选证据时抬起，诊断阶段显示锁定和证据对照。
- **阅读工具**使用光学装置与检测扫光，沿用拍照、全文翻译、重点生词、长难句处理、复制及导出流程。
- **参考估分**使用分层校准装置、总分刻度盘和分项条。总分盘以 `clamp(总分, 0, 710) ÷ 710 × 270°` 映射已有计算结果。写译反馈和备考建议接在原结果区。

`workbench.js` 根据三种装置的尺寸参数构造 CSS 3D 面片，`workbench.css` 用 `perspective` 和 `preserve-3d` 展示深度。正文和表单保持便于阅读的方向，动效出现在装配、按压、检视和结果反馈时。减少动态效果由媒体查询和图谱控制逻辑共同处理。

## 5. 文档、补丁和验收媒体

### 交接文件

| 文件 | 用途 |
| --- | --- |
| [CET 作战中心 Qoder 实施指令.md](<CET 作战中心 Qoder 实施指令.md>) | 按真实源码写出首版功能结构、数据接入和可复现验收步骤。 |
| [CET 作战中心 Qoder 视觉返工指令.md](<CET 作战中心 Qoder 视觉返工指令.md>) | 根据浏览器截图与实测，明确裁切、按钮尺寸、首次反馈和图谱视差的返工目标。 |
| [CET 作战中心 Qoder 续跑补丁.patch](<CET 作战中心 Qoder 续跑补丁.patch>) | 原项目早期两文件修复，处理窄屏边界、Enter 激活、图谱焦点和视差断言，属于当时的版本基线。 |
| [CET Command Edition.patch](<CET Command Edition.patch>) | 初版作战中心交接差异，包含线框球、扫描弧和简洁文案。 |
| [CET Command Award Edition.patch](<CET Command Award Edition.patch>) | 加入近远分层球体、透视网格和五轴雷达的完整交接差异，对应当时的原项目基线。 |
| [CET Command 3D Upgrade.patch](<CET Command 3D Upgrade.patch>) | 以 `c38c732` 为基线的四层实体底座和相关测试增量。 |
| [CET Full 3D Workbench.patch](<CET Full 3D Workbench.patch>) | 同样以 `c38c732` 为基线，已经包含四层底座和全站双模式。对该基线选择这一份即可。 |
| [CET 作战中心实施与交付报告.md](<CET 作战中心实施与交付报告.md>) | 本报告。 |

### 浏览器截图和演示录屏

| 文件 | 内容 |
| --- | --- |
| [command-desktop.png](cet-studyhack-command-edition/dev/acceptance/command-desktop.png)、[command-wide.png](cet-studyhack-command-edition/dev/acceptance/command-wide.png) | 桌面与宽屏作战中心。 |
| [command-mobile.png](cet-studyhack-command-edition/dev/acceptance/command-mobile.png)、[command-mobile-radar.png](cet-studyhack-command-edition/dev/acceptance/command-mobile-radar.png) | 手机首屏与手机雷达。 |
| [command-radar.png](cet-studyhack-command-edition/dev/acceptance/command-radar.png)、[command-layers.png](cet-studyhack-command-edition/dev/acceptance/command-layers.png) | 用实际练习产生的五轴战绩，及四层底座展开画面。 |
| [simple-desktop.png](cet-studyhack-command-edition/dev/acceptance/simple-desktop.png) | 简约模式桌面视图。 |
| [workbench-lab.png](cet-studyhack-command-edition/dev/acceptance/workbench-lab.png)、[workbench-tools.png](cet-studyhack-command-edition/dev/acceptance/workbench-tools.png)、[workbench-estimator.png](cet-studyhack-command-edition/dev/acceptance/workbench-estimator.png) | 三个科技功能页的验收截图。 |
| [command-interaction.mp4](cet-studyhack-command-edition/dev/acceptance/command-interaction.mp4) | 初版图谱拖动、锁定、首条诊断回传。 |
| [command-award.mp4](cet-studyhack-command-edition/dev/acceptance/command-award.mp4) | 五轴版从选题、重答到同类练习完成。 |
| [command-3d.mp4](cet-studyhack-command-edition/dev/acceptance/command-3d.mp4) | 四层底座的展开、旋转、收拢和节点锁定。 |

截图由本地 Chrome 执行真实交互后捕获，最新版验收会重写同名截图。录屏使用 Chrome 截取页面帧并由 FFmpeg 编码。重复试验用的浏览器配置、视频帧和补丁预检产物在临时目录生成。

## 6. 验收方法与结果

先从原站点的 `screen-reading` 预置题建立一条可复现路径。首答选 A 并选 `s5`，确认短提示阶段没有新增记录，再重答 B。进入同类题后选 B 并选 `s2`，检查结果、沙盘脉冲、雷达与日志只更新一次。随后切换模式和页面，检查草稿保留、键盘焦点、窄屏范围以及减少动态效果。

首次检查测到 390px 下节点越界，先调整紧凑视口的几何余量，再处理 Enter 事件和重绘焦点。拖动断言以节点之间实际出现不同位移为准。装置改版后增加展开与复位的几何检查，以及手机底座完整落在视口内的断言。阅读工具、写译和拍照相关测试使用本地夹具服务。

| 已完成的验收 | 结果 |
| --- | --- |
| Qoder 早期卡点的临时修复验证 | 69 项浏览器验收通过。 |
| Codex 五轴雷达与作战中心版本 | 75 项浏览器验收通过。 |
| Codex 四层 3D 底座版本 | 78 项浏览器验收通过，覆盖展开、复位和手机底座完整显示。 |
| Codex 最新全站双模式版本 | 87 项浏览器检查通过，浏览器异常为零。8 项本地测试通过。接口夹具流程通过。 |

在 Windows PowerShell 中运行本地预览。

```powershell
Set-Location -LiteralPath 'C:\Users\Leo18\OneDrive\Desktop\cet-handoff\cet-studyhack-command-edition'
$env:PORT = '4332'
node dev/server.mjs
```

预览地址为 `http://127.0.0.1:4332/`。独立启动带夹具的服务用于回归测试。

```powershell
Set-Location -LiteralPath 'C:\Users\Leo18\OneDrive\Desktop\cet-handoff\cet-studyhack-command-edition'
$env:PORT = '4333'
node dev/server.mjs --test-fixtures
```

在另一终端执行回归。

```powershell
Set-Location -LiteralPath 'C:\Users\Leo18\OneDrive\Desktop\cet-handoff\cet-studyhack-command-edition'
$env:CET_TEST_BASE = 'http://127.0.0.1:4333'
$env:CET_TEST_FIXTURES = '1'
node dev/accept-command.mjs
node --test dev/test-command-history.mjs dev/test-engine.mjs dev/test-lab.mjs
node dev/test-flow.mjs
```

上述接口回归是模拟服务验证。线上 Qoder AI 服务的实时耗时与输出不在这组结果中。

## 7. Qoder 独立实现与来源说明

Codex 通过 Qoder CN 的同一任务会话发派了以下阶段。采用短任务、按需读取相关区段和单次回归的方式，目标是减少重复加载和验收。未取得 Qoder 实际计费构成，无法核算节省金额。

1. **双模式基础。** Qoder 修改了原项目的 `web/index.html`、`web/shell.js` 和 `web/command.css`，验证了切换、留在当前页和刷新记忆。
2. **功能页仪器。** Qoder 新增 `web/instruments.js`，并通过 `web/app.js`、`web/index.html`、`web/command.css` 接入。它报告验证了答题装配与锁定、实时估分刻度、草稿保留、390px 布局和减少动态效果。
3. **作战中心与验收。** Qoder 修改原项目中的 `web/command-graph.js`、`web/command-history.js`、`web/command.css`、`web/command.js` 和 `web/index.html`，完成可拖动、可展开的底座与真实五轴雷达，并用夹具验证拍照状态。随后更新自己的 `dev/accept-command.mjs`，报告 **81 项通过、零失败、零浏览器异常**。 [Qoder 桌面截图](cet-studyhack-lab/dev/acceptance/command-desktop.png) · [Qoder 手机截图](cet-studyhack-lab/dev/acceptance/command-mobile.png)
4. **视觉参考轮。** 对照最新可确认的同尺寸截图后，向 Qoder 派发首屏雷达、四层厚侧壁和中文节点名的定点改进，明确允许它参考一张 Codex 截图，代码继续使用 Qoder 对原项目的实现。报告采用上一轮可核对的截图和 81 项结果，视觉参考轮的后续产物待单独核对。

对外说明可按实际提交版本描述为「Codex 制作过独立原型与视觉参考，Qoder 在原项目中实现自己的版本并进行浏览器验收」。若展示的是已经参考 Codex 截图的后续界面，应随演示说明这项参考。以实际 Qoder 会话、文件改动、验收结果和提交记录证明各自完成的工作。
