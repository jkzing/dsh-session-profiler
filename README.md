# dsh-session-profiler

把一次 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）会话画成时间线：按类别分道的**调用轨迹图**、**火焰图**和**耗时统计**，看清时间花在模型、工具，还是等人上。

![调用轨迹](docs/tracks.png)

安装后，每个会话的标签栏里会多出一个 **分析** 标签页（在「轨迹」右边）。

## 能看到什么

- **轨迹**：每个类别一条泳道（模型推理、构建 / 测试、命令 / 脚本、版本控制、读文件 / 搜索、改代码、联网、图像 / 界面、子智能体、MCP 工具、等待用户、其他），并行的调用自动分行。
- **火焰图**：按嵌套深度排布——步骤 → 模型与工具调用 → 子调用 / 后台进程。
- **统计**：按类别、按工具的次数 / 累计 / 平均 / 最长 / 失败数，以及最慢的 20 次调用（点一行跳回轨迹并定位）。
- **概览**：最上面一条，整个会话各类别的忙闲分布，带自己的时间刻度；亮起的一段是下方图表当前显示的范围。
- **轮次与阶段**：时间轴下面两行。阶段取自会话里的 todo 列表——哪一项是「进行中」，这段时间就归它；没有 todo 的轮次用该轮的提问作标题。
- **耗时构成**：把轮次内的时间切成 模型 / 工具 / 等待用户 / 其他开销 四份，加起来等于活跃时间。另有总时长、空闲、平均首字耗时、Token。
- **模型调用的内部分段**：等待首字、思考、输出回复、生成工具调用参数，来自日志里带时间戳的流。
- **后台进程**（斜纹）：`run_in_background` 启动、工具调用返回后仍在运行的进程，画到它真正结束为止。
- **失败**（红框）、**没有返回事件的调用**（虚线，比如轮次被中止）、**运行中**的调用（实时会话里随时间延伸）。
- **折叠空闲**：轮次之间超过一分钟的空档折成一条窄带，否则一个跨了几天的会话只剩几根细线。

操作：滚轮缩放（在左侧标签列上滚动则是上下滚动泳道），拖拽平移，点击看详情（参数与结果按需加载），双击聚焦到某个调用 / 阶段 / 轮次，顶部概览条里拖动视窗来平移、拖两侧的手柄来改变范围，搜索框按命令或文件名高亮。键盘：`+` `-` 缩放，`0` 全览，方向键平移，`Esc` 取消选中。

正在运行的会话会自动刷新，只传输变化的部分。

## 安装

需要 dsh `>= 0.2.2-rc.1`（在 0.2.2-rc.1 上验证过）。

```bash
git clone https://github.com/jkzing/dsh-session-profiler.git && cd dsh-session-profiler
pnpm install         # 会顺带构建出 lib/
dsh plugin --profile web add .
```

然后重启 `dsh web`。卸载：

```bash
dsh plugin --profile web remove dsh-session-profiler
```

## 自定义泳道

内置分类是通用的。想要项目专属的泳道（比如把数据库相关的命令单独列一道），在 profile 的 `cordis.patch.yml`（`~/.dsh/profiles/web/cordis.patch.yml`）里加：

```yaml
- update:
    - id: dsh-session-profiler
      config:
        categories:
          - id: database
            label: 数据库
            color: '#f97316'
            match: '\b(psql|mysql|prisma)\b'
```

`match` 是正则（不区分大小写），匹配对象是 `"<工具名> <一行描述>"`——对 `bash` 来说描述就是命令本身。自上而下第一条命中的规则生效，优先于内置分类。写错的规则会被跳过并在 dsh 日志里给出警告。

## 工作方式

```
src/shared   事件 → 时间线数据的纯函数（主机、测试、离线脚本共用）
src/host     主机端：两个 POST 路由，读会话事件并折叠成时间线数据
src/client   浏览器端：标签页、Canvas 图表、统计表、详情面板
```

- 主机端不订阅任何事件，也不往会话日志里写东西。每次请求通过 `sessionQuery.observeSession` 读取已提交的事件——在线会话走内存，冷会话走持久化。
- `POST api/dsh-session-profiler/timeline { sessionId, since? }` 返回整份时间线数据，或自 `since` 以来变化的 span（span 的 id 只由日志前缀决定，所以增量合并是确定的）。
- `POST api/dsh-session-profiler/span { sessionId, seq }` 返回某个 span 的参数与结果，点击时才取。
- 浏览器端注册到 `conversation.view` 插槽。在这个标签页显示期间，对话的输入框会让出位置（有待处理的审批或计划评审时除外）。

用到的事件：`turn/*`、`step/*`、`assistant/message`、`assistant/attempt`、`tool/call`、`tool/result`、`tool/ptc-dispatch*`、`job/registered`、`job/settled`、`approval/*`、`subagent/catalog`、`agent/inbox/spliced`、`todo/write`、`llm/retry-started`、`compaction/*`、`command/*`。

## 已知限制

- 后台进程依赖 `job/*` 事件；较早版本的 dsh 写下的会话没有这些事件，那里的后台命令只显示为一次很短的工具调用。
- 子智能体只画出它「从启动到结束」的时间段，不展开子会话内部的调用。
- 阶段来自 todo 列表，不做语义总结；没用 todo 的会话每轮只有一个阶段。
- fork 出来的会话只显示它自己的部分，不含继承自父会话的历史。
- 泳道里的行数有上限（模型 2 行，其余 5 行），并行度更高时会叠在同一行。

## 开发

```bash
pnpm check           # 类型检查 + 测试 + 构建
pnpm watch           # 改动即重新构建
pnpm preview         # 不依赖 dsh 的预览页：http://127.0.0.1:4173/
```

预览页用一份合成的会话（`scripts/demo-log.mjs`）驱动真实的主机端和浏览器端代码：

- `?session=demo` 一份三个多小时的完整会话；`?session=live` 同一份日志按真实时间回放，用来看轮询
- `?view=flame|stats`、`?theme=light`、`?lang=en`
- `pnpm preview ~/.dsh/sessions/<工作区>/<会话>` 加载一份真实会话（需要 `zstd` 命令行）

离线把一份会话折叠成 JSON：

```bash
pnpm timeline ~/.dsh/sessions/<工作区>/<会话> --summary
```

想在真实的 dsh 里试而不动自己的 profile，可以用一个临时的 `DSH_HOME`：

```bash
DSH_HOME=/tmp/dsh-home dsh plugin --profile web add "$PWD"
```

```bash
DSH_HOME=/tmp/dsh-home dsh web --no-open --port 47311
```

## License

MIT
