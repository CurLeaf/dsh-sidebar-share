# 本地安装笔记（不发布到 npm）

## 当前状态（2026-10-26 20:45）

- 包版本 **0.1.3**，`desktop` profile 里仍是本地 link：
  - `~/.dsh/profiles/desktop/package.json` → `"dsh-sidebar-share": "link:/Users/curleaf/WorkSpace/dsh-sidebar-share"`
  - `dsh.profile.bundles` 包含 `dsh-sidebar-share`
  - `~/.dsh/profiles/desktop/node_modules/dsh-sidebar-share` → 本目录
- 0.1.2 的 bug（关闭右栏后又被旧会话「修」回来）根因不在传播，而在**空模板修复**：
  - `repairGroup()` 把 `layoutScore === 0` 当坏模板，用 `pickSeed()` 扫全工作区会话（含归档）回填；
  - `seedLayout()` 在 canonical 为空时直接 adopt 当前会话的旧内容；
  - 传播只打已挂载实例，归档/未挂载会话的旧 tab 留在 localStorage，下次继续被当种子。
- 0.1.3 彻底删掉这条思路，换成 v2 模型：
  - canonical 只由**活着的、非归档的**会话写入；某个工作区**没有 canonical 时才采纳一次**当前会话，之后绝不重建；
  - 空 canonical 是权威状态：关闭全部 tab → 其余会话同步变空并收起，新会话也是空的；
  - 空内容一律按 `expanded: false` 应用，不会出现空面板自己弹开；
  - 归档会话既不作为模板也不接收同步；
  - 迁移：删除所有 `dsh.sidebar-share.v1.*`，写显式 `reset` 到 `dsh.sidebar-share.v2.*`，让旧数据一次性失效。

## 0.1.3 追加：引用到对话（2026-10-26 21:05）

同一个 0.1.3 里还加了一个侧栏 → 输入框的入口，方便打包时一次发布：

- 右侧栏任意 tab 的右键菜单里新增「引用到对话」（slot：`sidebar.right.tab.menu.item`，id：`sidebar-share:chat-reference`）。
- 插入内容：文件/预览 tab → `@相对路径 `（含空格自动加引号）；浏览器 tab → 当前 URL；终端 tab → 可见屏幕最后 60 行，包成 text 代码块。
- 写入方式：session 作用域的 `inputActions`（`captureInsertion()` + `insertText()`），可撤销、不覆盖草稿；没有编辑器时退回剪贴板。
- 终端读的是 xterm DOM 渲染器的可见屏幕（`.xterm-rows`），不含滚动历史；后台终端 tab 可能读到当时可见的那个终端。
- 宿主没有该插槽/`inputActions` 时静默不注册，原镜像逻辑不受影响。
- 代码在 `dist/client.js` 的 `Sidebar → chat reference` 段；harness 覆盖了菜单注册与点击插入。

## 0.1.4：侧边栏范围配置（2026-10-26 21:15）

- **Host 半**（`dist/index.js`）不再完全空转：导出 schemastery 的 `Config`（`scope: 'workspace' | 'session'`，默认 `workspace`），并在 `apply` 里 `ctx.settings.configure({ auto: false }, ctx.fiber)`，让设置命名空间以条目 id `sidebar-share` 进入 Host 设置文档。
- **Client 半**（`dist/client.js`）：
  - 启动时用 `ctx.get('configForms').get('sidebar-share')` 读 `scope`，`session` 时整个镜像引擎直接空转（`sweep` / `observeHandle` / 两个 change 回调都先判 `scopeMode`）；
  - 订阅设置变更，`setScopeMode()` 会退订并清空所有 group，切回 `workspace` 时重新扫一遍并按 canonical 对齐，因此切换即时生效；
  - `plugins.bundle.config` 注册一行「侧边栏范围」单选（key = 包名 `dsh-sidebar-share`），写入走 `configForm.set('scope', …)`；
  - 调试出口加了 `window.__DSH_SIDEBAR_SHARE__.scope()` / `.setScope()`。
- **依赖**：host 半 import `@deepseek-ai/schemastery`（peerDependency `^3.18.1`，Host 侧已有）。本机是 `link:` 安装、插件目录在 profile 外，Node 解析不到 peer，所以本地建了 `node_modules/@deepseek-ai/schemastery` 软链到 `~/.dsh/profiles/desktop/node_modules/...`——**只用于本地开发，不进 npm 包**（`files` 白名单本来也不含 node_modules）。
- **验证**：
  - `node --check dist/client.js`、`node test/harness.mjs` 通过；harness 新增：设置行注册（key 校验）、`session` 模式不改写 canonical、切回 `workspace` 后按 canonical 重新对齐；
  - host 半用 Electron node 直接 import 验证：默认 `workspace`、接受 `session`、非法值被拒，`apply` 调用到 `settings.configure`。
- **待办**：0.1.4 改了 Host 半，**只 Cmd+R 不够**：需要重启 DSH（或插件页关/开一次），再确认「侧边栏范围」出现并可切换，然后发 0.1.4。

## 本机现场（修复前）

- WorkSpace（`3a37ffca-a4ce-4ad3-b781-dd470453f278`）canonical `savedAt = 2026-10-26 20:31:48`（本次启动后 34s），内容为 3 个 coupon 图片 tab + `expanded: true`，`contentId` 指向**已归档**会话 `5dbcd6c5`。
- 20:33 新建的会话 `3741c03c` 一创建就带着同样 3 个 tab + `expanded: true`。
- 多个会话的 `dsh.sidebar-right.v1.*` 布局被插件改写成彼此一致（contentId 换成各自 session id），可证明插件确实在运行。

## 真实数据回放（修复后，2026-10-26 20:47）

把本机 leveldb 里真实的 v1 canonical + 各会话 `dsh.sidebar-right.v1.*` 取出来，喂给 0.1.3 的 client 跑了一遍（脚本在 `/tmp/verify-real.mjs`，不随包发布）：

- v1 canonical 的三个 coupon tab（`tab12/13/14`，指向归档会话 `5dbcd6c5`）被识别并删除；
- 两个仍活跃的会话 `20966b82`、`97fac8ef` 的旧 tab 被清空、`expanded` 置为 false；
- 新建的探针会话保持空且收起；
- 已归档会话（`5dbcd6c5`、`3741c03c`、`978f565b`、`3b0bad5d` 等）的 store 保持原样，不参与；
- 落盘结果为 `dsh.sidebar-share.v2.<workspaceId>`：`version: 2, reset: true, layout: null`。

结论：迁移会把旧的三个 coupon tab 彻底清掉，不会再被任何路径重建。

## 验证

```bash
cd /Users/curleaf/WorkSpace/dsh-sidebar-share
node --check dist/client.js
node test/harness.mjs
```

harness 覆盖：v1 → v2 迁移、reset 清空并收起、首个 tab 解除 reset、镜像与文件地址改写、关闭全部后不被 sweep / 新会话复活、归档会话不参与、无 canonical 工作区一次性采纳、展开状态按窗口隔离；另外覆盖「引用到对话」的路径 / URL / 终端文本生成、菜单注册与点击插入。

刷新窗口后 console 里应看到：

```
[sidebar-share] migrated v1 canonicals 1
[sidebar-share] restored workspace <id> (reset)
[sidebar-share] observing layout session-...
```

之后关闭全部 tab，再开新会话：右侧栏应为空且收起；`localStorage['dsh.sidebar-share.v2.<workspaceId>']` 里 `tabs` 为空、`reset: false`。

## 备份

- `~/.dsh/profiles/desktop/package.json.bak-sidebar-share-20261025-144511`
- `~/.dsh/profiles/desktop/pnpm-lock.yaml.bak-sidebar-share-20261025-144511`
- `~/.dsh/profiles/desktop/cordis.patch.yml.bak-sidebar-share-20261025-144511`

## 回滚

插件页面卸载 `dsh-sidebar-share`，或：

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop remove dsh-sidebar-share
```

再从 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 删掉 `dsh-sidebar-share`，重启 DSH。各会话原有侧栏仍在 `dsh.sidebar-right.v1.<sessionId>` 中。
注意：v2 迁移会删掉 v1 canonical，回滚后旧插件会重新按「最丰富会话」引导一次。

## npm

- `dsh-sidebar-share@0.1.3`（v2 修复 + 「引用到对话」）与 **0.1.4**（侧边栏范围配置）均已发布为 latest；0.1.4 发布于 2026-10-26 21:10。
- 发布：`bash scripts/release.sh`（Keychain service `npm-dsh-sidebar-share` 里有 token；脚本会检查版本、`node --check`、harness、`npm pack --dry-run`、publish、`npm view`）。
- 发布前建议先在本机 Cmd+R 验证 0.1.3 行为，再 `bash scripts/release.sh`（当前版本已是 0.1.3）。

## 2026-10-26 20:58 发布结果（0.1.3）

- `npm publish --access public` 返回 `+ dsh-sidebar-share@0.1.3`；`npm view` 立即能查到，`dist-tags.latest = 0.1.3`。
- 发布物 6 个文件 / 15.1 kB（`dist/client.js` 38.8 kB），sha512 integrity 与本地 `npm pack` 一致。
- 从 registry 重新下载 tarball 校验：`dist/client.js` 里包含 `chat reference menu registered`，版本 0.1.3。
- 本机 profile 仍是 `link:` 到本目录，Cmd+R 后加载的就是刚发布的同一份代码。
- 发布用的 token 来自 Keychain（`npm-dsh-sidebar-share`），`npm whoami` 走 ~/.npmrc 旧登录仍会失败，属正常。

## 2026-10-26 21:10 发布结果（0.1.4）

- `npm publish` 返回 `+ dsh-sidebar-share@0.1.4`；`npm view` 立即可查，`dist-tags.latest = 0.1.4`。
- 发布物 6 个文件 / 18.0 kB；从 registry 重新下载校验：`dist/index.js` 含 `Config` + `settings.configure`，`dist/client.js` 含 `plugins.bundle.config` / `setScopeMode`。
- 本地 profile 仍 link 到本目录；**必须重启 DSH**（或插件页关/开一次）才会加载新的 Host 半，只 Cmd+R 只更新客户端。
- 重启后确认：插件页 `dsh-sidebar-share` 出现「侧边栏范围」，默认 `workspace`，切 `session` 后不再跨会话镜像。

## 2026-10-27 迁移到 Linux（/home/yxw/WorkSpace）

- 仓库已接上 origin（`git@github.com:CurLeaf/dsh-sidebar-share.git`），HEAD `ee2753b`；
  `web` profile 里仍是 `link:/home/yxw/WorkSpace/dsh-sidebar-share`，`dsh.profile.bundles` 含本插件。
- macOS 时代的 schemastery 软链没有跟过来，宿主半一加载就
  `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'`，整个插件不生效。
  这台机器改用「本地装一份」而非软链（同样不进 npm 包 `files` 白名单）：

  ```bash
  cd /home/yxw/WorkSpace/dsh-sidebar-share
  npm install --no-save --no-package-lock @deepseek-ai/schemastery@3.18.5
  ```

  `3.18.5` 与 DSH 内置版本一致；改 `dist/index.js` 后可这样自检：

  ```bash
  node --input-type=module -e "import('/home/yxw/WorkSpace/dsh-sidebar-share/dist/index.js').then(m=>console.log(Object.keys(m)))"
  # 期望输出 Config,apply,name
  ```

- release.sh / npm-token.sh 里写死的是 macOS Keychain 与 `/Users/curleaf/...` 路径，Linux 上发布前需要改。

## 2026-10-27 修复：「侧边栏范围」切不到「会话独立」

- 现象：插件页能选「会话独立」，但切完仍是工作区共享（`scopeMode` 永远 `workspace`）。
- 根因：`Config` 里 `scope` 用了 `.volatile()`。schemastery 3.18.5 的 volatile 字段解析成
  「稳定引用」（要 `.get()` 才拿到值），而浏览器半是 `snapshot.value.scope === 'session'` 直比字符串，
  于是永远不相等。`JSON.stringify(Config({}))` 会显示成 `{"scope":{}}` 就是这个原因。
- 顺带确认：这不是 union 写法的问题——`z.union(['workspace','session'])` 在 3.18.1 / 3.18.5
  不带 `.volatile()` 时都正常（默认 `workspace`、传 `session` 保留、非法值被拒）。
- 修法：去掉 `.volatile()`。用户偏好本来就该是普通持久化值，官方设置插件也是直接读
  `snapshot.value?.key`，不用 `.get()`。
- 自检：`Config({}) === {scope:'workspace'}`、`Config({scope:'session'}) === {scope:'session'}`、
  `Config({scope:'bogus'})` 抛错。`node test/harness.mjs` 仍 ok。

## 0.1.6：tab 右键菜单加「在访达 / 文件管理器 / 资源管理器中显示」（2026-10-31）

### 需求

侧边栏 tab 的右键菜单里要能「把文件在访达中打开」，Windows 上则是文件资源管理器。菜单槽位就是既有的 `sidebar.right.tab.menu.item`。

### 实现

- 新条目 `sidebar-share:reveal-in-file-manager`（order 90，排在「引用到对话」100 之前），只对 `dsh-resource://file/...` 的 tab 渲染。
- 路径解析：先 `parseFileAddress()`（支持 `session/<id>/<相对路径>`、`session/<id>//<绝对路径>`、`absolute/<路径>`、Windows 盘符与 UNC），绝对路径直接用；否则 `remote.workspaceFiles.stat(sessionId, path)` 拿 Host 校验过的 `absolutePath`——与文档预览「显示文件位置」同一条链路。
- 打开：`remote.session.openWorkspacePath({ path, action: 'reveal' })`。macOS `open -R`、Windows 资源管理器选中、Linux `xdg-open` 打开所在目录，都在 Host 侧。
- 平台文案：优先读 Host 的 `open-in-app/apps`（`finder` / `explorer` / `filemanager`），失败时按 Host home 拼写判断（`/Users/`→访达，`C:\`/`\\`→资源管理器，`/home/`、`/root`→文件管理器）。**不看浏览器 UA**：远程连 Linux 宿主时应显示「在文件管理器中显示」。
- 未知时才隐藏：判断不出平台且 `canOpenWorkspacePath()` 为 false 才不渲染；否则渲染，失败用顶部 toast 说明原因。
- probe 时机：`ctx.inject(['remote'])` 后再探，未知答案按 400ms/800ms… 重试 5 次（`$host.home` 要等第一条 generation 才有值）。首版在 apply 里立刻探，探到 `undefined` 后不重试，菜单里就永远看不到这一项（真机复现过）。
- toast：复用 DSH 的 toast 位置（`top:40px` 居中、`z-index:1100`、`role=alert`、`--dsw-alias-toast-*` 配色）。
- 「引用到对话」一并修：宿主实际会传 `inputActions`（session props face），真机验证插入 `@路径` 成功；没有时改为复制到剪贴板 + 顶部提示（异步 `clipboard.writeText`，失败再退回 `execCommand('copy')`），不再静默。
- 菜单样式对齐 dockkit 原生项：28px 高、8px 内边距、`--dsw-radius-md`、hover 用 `--dsw-alias-interactive-bg-hover`、14px 线性图标。

### 验证

- `node test/harness.mjs`：新增地址解析（相对 / session 绝对 / absolute / drive / UNC）、三平台文案、点击后 `stat` + `openWorkspacePath({action:'reveal'})`、绝对地址不 stat、Host 拒绝不抛、探测失败回退 home、识别不出时隐藏、`inputActions` 缺失时走剪贴板、browser tab 用 `sidebarRight.mounted` 补 sessionId。
- 真机（本项目所在的 web profile，Chrome headless + CDP 127.0.0.1:9223，token 来自 systemd journal）：
  - 插件加载：`version 0.1.6`、两条 `menu registered` 日志；
  - 文件 tab 右键菜单实际顺序：`关闭` → `在文件管理器中显示` → `引用到对话`；
  - 点击「在文件管理器中显示」：`[sidebar-share] revealed /home/yxw/Project/erp-admin-demo-1/.env in directory`，Host 真的开了文件管理器；
  - 把 `open-in-app/apps` 依次伪造成 `finder` / `explorer` / `filemanager` 再 `refreshFileManager()`，菜单文案分别变成「在访达中显示」「在文件资源管理器中显示」「在文件管理器中显示」；
  - 点击「引用到对话」后输入框出现 `@.env `（`inputActions` 路径生效）；失败 toast 截图确认位置/配色。
- 本机环境注意：`dsh-web.service` 的 env 里没有 `DISPLAY`/`WAYLAND_DISPLAY`，所以 `open-in-app/apps` 只有 `["cursor"]`（目录里的 `filemanager` 项要求显示服务器），但 `revealNativePath` 不看显示，`xdg-open` 走 D-Bus 仍然成功。这也是「平台判定不能只看 catalog 有没有 filemanager」的原因。

### 兼容

- 只改浏览器半，刷新窗口即可；`PLUGIN_VERSION` 与 `package.json` 都升到 0.1.6。

### 补充：引用到对话的光标位置（同版本修复）

- 现象：文件 tab 右键「引用到对话」后，`@路径` 插在了正确的光标位置，但输入框光标跳到**开头**。
- 根因：旧实现先 `dismiss()` 再 `captureInsertion()` + `insertText()`，最后 `setTimeout(focusComposer, 0)`。菜单关掉后编辑器仍是失焦状态，插入完成后再 `element.focus()` 会把 DOM 光标落到编辑器开头（Lexical 的 selection 不参与这次 focus）。
- 修法：`captureInsertion()` 先取失焦前残留的 Lexical selection；**先 `focusComposer()` 再 `insertText()`**（编辑框有焦点时 Lexical 会在 applyEdit 后把 caret 放到插入内容之后）；最后再 `dismiss()`。顺序固定为 capture → focus → insert → dismiss，harness 里用假 editor 断言了这个序列。
- 真机复现/回归（CDP，当前会话）：输入 `AAA BBB`，caret 4 → 右键 .env tab → 引用到对话：修复前 `caret=0`，修复后 `caret=10`（`AAA @.env` 之后），文本 `AAA @.env BBB`。
- `focusComposer()` 现在取**可见的** composer（多个 contenteditable 时取最后一个可见的），避免分屏/多会话时聚焦错编辑框。

## 2026-10-31 17:01 发布结果（0.1.6）

- `npm publish --access public` 返回 `+ dsh-sidebar-share@0.1.6`；`npm view dsh-sidebar-share dist-tags` → `{ "latest": "0.1.6" }`。
- 从 registry 重新下载 tarball 校验：`dist/client.js` 含 `sidebar-share:reveal-in-file-manager`、`在访达中显示`、`在文件资源管理器中显示`，且插入顺序为 `captureInsertion()` → `focusComposer()` → `insertText()`；`PLUGIN_VERSION` 与 `package.json` 均为 `0.1.6`。
- 发布走 `scripts/release.sh`（本机没有 macOS Keychain，退回 `~/.npmrc` 的 token，`npm whoami` = `curleaf`）。
- 本机 web profile 是 `link:` 安装，刷新窗口即可用上 0.1.6；其它机器 `dsh plugin --profile web add dsh-sidebar-share`。

## 0.1.7：tab 右键菜单加「关闭其他标签页 / 关闭右侧标签页」（2026-10-31）

### 需求

右侧栏 tab 的右键菜单要能批量关 tab：关掉当前分栏里「其他的」，以及「当前 tab 右边的」。槽位仍是 `sidebar.right.tab.menu.item`，宿主自带的「关闭」之后追加。

### 实现

- 两个新条目：`sidebar-share:close-others`（order 60，「关闭其他标签页」）、`sidebar-share:close-right`（order 70，「关闭右侧标签页」），都排在「在访达中显示」90 与「引用到对话」100 之前。
- 作用域是**当前分栏**：`paneOfTab(layout, tabId)` 在 `layout.nodes` 里找 `kind === 'pane'` 且 `tabs` 含该 id 的节点，所以分屏出来的另一个 pane、浮窗里的 tab 都不会被牵连。
- 目标集合：`others` = 该 pane 的 `tabs` 去掉自己；`right` = `tabs.slice(index + 1)`。没有目标就 `return null`，菜单里不出现死项。
- 布局读取顺序：先 `sidebarRight.screen()`（控制器只认屏幕上那个会话），拿不到再用本插件镜像住的 layout store（`groups[].layoutInstances`，覆盖被镜像的其它会话）。两个都拿不到就视为无可关项。
- 关闭调用顺序：优先 `sidebarRight.closeIn(sessionId, tabId)`——它带 `canCloseTab` 守卫，还会跑 tab 类型自己的 `closeHandlers`（终端收尾就走这里）；宿主没有这个入口时退回 `sidebarRight.actionsFor(sessionId).closeTab(sessionId, tabId)`。见 DSH `ui-sidebar-right` 的 `closeIn()`。
- 从右往左关（`for (index = targets.length - 1; ...)`），让 kit 的 settle 把焦点留在最靠左的幸存 tab 上；每关一个是一条布局历史，撤销是逐条的。
- 菜单项先 `dismiss()` 再动布局：和「在访达中显示」一致，菜单不能浮在刚变过的内容上。
- 新增调试面：`tabMenu.closeTargets(sessionId, tabId, mode)` 与 `tabMenu.closeSiblings(props, mode)`，harness 直接断言目标集合。

### 验证

- `node test/harness.mjs`：四个条目与 order/label；`closeTargets` 的 others/right 集合；点击后 `closeIn` 按「右→左」顺序调用、`dismiss` 先于关闭；「最后一个 tab」与「只有一个 tab」时条目为 null；未采纳会话（无 layout）时条目为 null；分屏后另一个 pane 的 tab 不在目标里；`closeIn` 缺失时退回 `actions.closeTab`。
- 真机待验证（0.1.7 未发布，本机 `link:` 安装，刷新窗口即可试）。

### 兼容

- 只改浏览器半（`dist/client.js`），刷新窗口即可；`PLUGIN_VERSION` 与 `package.json` 都升到 0.1.7。
- 依赖的 `sidebarRight.closeIn` / `screen()` / `actionsFor()` 是 `ui-sidebar-right` 的控制器方法（不是 `ISidebarRight` 的公开面），DSH 升级后若改名，关闭会退回 store action；两者都没有时菜单项仍在、点击只弹 toast，不影响镜像。
