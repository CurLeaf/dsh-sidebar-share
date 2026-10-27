# dsh-sidebar-share

让**同一个 DSH 工作区里的所有会话共用同一套右侧栏**：文件树、浏览器页、文档预览、终端等 tab 的布局，以及浏览器 tab 当前打开的页面，都会在会话之间同步。

> 非官方插件。通过 `ctx.slots.resolveStore` 与 DSH 0.2.1-rc.3 的 store 结构工作，DSH 升级后可能需要适配。

## 安装

在 DSH 的 **插件** 页面选择 **添加插件**，输入包名：

```
dsh-sidebar-share
```

也可以在你使用的 profile 下安装：

```
dsh plugin --profile <profile> add dsh-sidebar-share
```

例如桌面端 profile 是 `desktop`，Web 端是 `web`。

安装后重启 DSH（或重载窗口）加载客户端插件。

## 行为

- 每个工作区有一个 canonical 侧栏，保存在 `localStorage['dsh.sidebar-share.v2.<workspaceId>']`。
- canonical 只由**活着的、非归档的会话**自己的侧栏变化写入；同一工作区里已打开的会话之间实时镜像。
- 某个工作区第一次启用（还没有 canonical）时，用你当前操作的会话作为模板，**只采纳一次**；之后不再从任何历史会话的存档里重建模板。
- **空就是空**：把 tab 全部关掉是一个决定，不是「坏模板」。其余会话会同步变空并收起，之后新开的会话也是空的，不会被旧会话「修」回来。
- 内容为空时一律按收起应用（`expanded: false`），因此不会出现一个空面板自己弹开。
- 同工作区文件地址 `dsh-resource://file/session/...` 会改写成接收方会话 id。
- 当前激活的 tab / pane 只属于当前窗口；tab 内容、分栏、浮窗会同步。
- 归档会话不参与：既不作为模板，也不接收同步。

## 配置：侧边栏范围

右侧栏是「工作区共享」还是「会话独立」是插件配置项，在 **侧栏 → 插件 → 已安装插件 → dsh-sidebar-share** 的配置区切换（`plugins.bundle.config`，按包名 `dsh-sidebar-share` 挂载）：

| 取值 | 行为 |
|---|---|
| `workspace`（默认） | 同一个工作区的所有会话共用一套右侧栏，实时镜像 |
| `session` | 每个会话各自保留侧栏，等同 DSH 官方默认；插件不再读写任何 canonical |

- 切换**立即生效**，不需要刷新。
- 从 `session` 切回 `workspace` 时，会用该工作区现有的 canonical 对齐所有已打开会话；没有 canonical 的工作区会采纳一次当前会话。
- 也可以在 profile 的 `cordis.patch.yml` 里固定：

```yaml
- id: sidebar-share
  config:
    scope: session
```

- 值保存在 Host 用户设置文档里，同一 Host 的所有已认证浏览器共享。
- 宿主没有 `configForms`（ui-settings）时按 `workspace` 运行，配置区不出现，镜像功能不受影响。

## 引用到对话（把侧栏内容送进输入框）

右侧栏任意 tab 的**右键菜单**里多了一项 **「引用到对话」**。点一下，就把这个 tab 的内容插入当前会话输入框的光标处：

| tab 类型 | 插入内容 |
|---|---|
| 文件 / 预览 | `@相对路径 `（路径含空格时自动变成 `@"..."`）；发出去后模型会自己去读这个文件 |
| 浏览器 | 当前页面的 URL |
| 终端 | 终端**当前可见屏幕**的最后 60 行，包在 ` ```text ` 代码块里 |

- 插入走 DSH 的公开输入面（`inputActions.captureInsertion()` + `insertText()`），是一次可撤销的纯文本编辑，**不会覆盖**已有草稿。
- 插入后焦点回到输入框，你接着写「把这个页面改成……」即可。
- 如果当前窗口没有可用的编辑器（例如草稿由别的窗口持有），会退化为复制到剪贴板，并在 console 里说明。
- 终端只能读到**可见屏幕**（xterm 的 DOM 渲染器，不含滚动历史）；后台终端 tab 读到的是当时可见的那个终端，请以实际插入内容为准。
- 宿主没有 `sidebar.right.tab.menu.item` 插槽或没有 `inputActions` 时，这一项不出现，不影响原有的镜像功能。

## 升级到 0.1.4

- 0.1.4 动了 **Host 半**（配置 schema 与 settings 命名空间），只按 Cmd+R 不够：需要重启 DSH，或在插件页把 `dsh-sidebar-share` 关掉再打开一次。
- 之后在插件页出现「侧边栏范围」，取值切换是即时的，不再需要刷新。

## 从 0.1.2 升级（0.1.3）

- 旧的 `dsh.sidebar-share.v1.*` canonical 会被删除，并写入一个显式的 reset。
- 升级后第一次加载会把各会话的旧侧栏清空并收起**一次**——包括此前被归档会话「回填」出来的 tab。
- 这是有意的：v1 的模板可能正是那条旧逻辑反复重建出来的坏数据，无法可靠区分「用户主动清空」与「启动竞态」，所以不做内容迁移，只做一次干净的重置。
- 迁移在插件加载时自动完成，无需手工清 localStorage；console 里会看到 `[sidebar-share] migrated v1 canonicals 1`。

## 不共享的内容

- 终端 PTY：每个会话仍是自己的 shell；terminal tab 的布局会同步，底层进程不共享。
- 浏览器页面实例：每个会话仍是自己的 webview/iframe，只是打开同一个 URL；页面内滚动、表单等临时状态不会同步。桌面端的 Cookie / 站点存储本来就按工作区共享。
- 会话内容、草稿、审批状态等其它 store。
- 右栏的展开/收起、全屏模式：每个窗口自己决定（只有「整个工作区为空」时会统一收起）。
- 没有工作区归属的会话（hero / 未分组）不参与。
- 归档会话。

## 临时关闭

在 DevTools console 里：

```js
localStorage.setItem('dsh-sidebar-share.disabled', '1')
```

刷新页面即可。恢复时删除该 key 再刷新。

## 兼容性

- 面向 DSH 0.2.1-rc.3 编写，依赖 `ctx.slots.resolveStore` 和 sidebar/browser store 的 `spec` 形状；「引用到对话」额外依赖 `sidebar.right.tab.menu.item` 插槽与 `inputActions` 输入面。
- 侧边栏范围设置依赖 Host 的 `settings` / `configForms`（ui-settings）与 schemastery。
- 这些不是公开 API；DSH 升级后可能需要改插件。升级前建议先禁用插件确认侧栏行为。

## 验证

```bash
node test/harness.mjs
```

harness 覆盖：v1 → v2 迁移、reset 清空并收起、用户打开第一个 tab 解除 reset、跨会话镜像与文件地址改写、关闭全部 tab 后不被 sweep / 新会话复活、归档会话不参与、空工作区一次性采纳、展开状态按窗口隔离，以及「引用到对话」的文件路径 / 浏览器 URL / 终端文本生成、菜单项注册与点击插入。

## License

MIT

---

本包由 `dsh-sidebar-share` 的浏览器半（`dist/client.js`）和空的 host 半（`dist/index.js`）组成；`cordis.patch.yml` 负责把自身插入 profile 的 bundle 列表。
