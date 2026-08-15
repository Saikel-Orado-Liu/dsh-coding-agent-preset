# Pro 测试数据：黑洞 / MC（coding 模式）

> 数据来源：`D:\Projects\_pro-test`、`D:\Projects\_pro-test1`
> 模型：`deepseek-v4-pro`
> Preset：`coding`
> `reasoningEffort`: `max`
> 统计口径：与 `dsh-router-standard/probe/analyze-session.mjs` + `classifier.mjs` 一致

## Demo 文件位置

- 黑洞产物与 Session：`demo/blackhole/`
- MC 产物与 Session：`demo/mc/`

## 一句话提示词

### 黑洞（`_pro-test1`）

```text
在当前工作目录创建一个单文件 blackhole.html，用 Three.js + WebGL 实现一个可交互的实时黑洞渲染：背景星空、黑洞事件视界、引力透镜扭曲背景、发光的吸积盘、鼠标拖拽旋转视角，所有代码内联在一个 HTML 文件中，打开即可运行。
```

### MC（`_pro-test`）

```text
在当前工作目录创建一个单文件 index.html，用 Three.js 实现一个网页版 Minecraft 风格可玩 Demo：包含随机起伏的地形、天空与光照、第一人称鼠标视角、WASD 移动、左键放置方块、右键破坏方块，所有 HTML/CSS/JS 都写在同一个文件里，并保证直接在浏览器打开就能运行。
```

## 统计表

| 来源 | 产物 | 推理模块 | we | let's | let me | 可见回复 | 工具调用 | 耗时 |
|---|---|---|---:|---:|---:|---:|---:|---:|
| `_pro-test1` | `blackhole.html` | 98 | 411 | 383 | 6 | 1 | 102 | ~29 分钟 |
| `_pro-test` | `index.html`（MC） | 162 | 525 | 539 | 4 | 1 | 167 | ~54 分钟 |

## 产物静态检查

### `blackhole.html`（黑洞）

- 大小：`26,574` 字节
- 行数：`876`
- 单文件 HTML，内联 CSS / JS / Shader
- 包含：
  - 程序化星空背景（2048×1024 星空全景）
  - Schwarzschild 度规光子测地线实时积分
  - 事件视界捕获判定
  - 发光吸积盘（ISCO、较差自转、多普勒聚束、引力红移）
  - 鼠标拖拽旋转 / 滚轮缩放 / 双击复位
  - Three.js CDN + 原生 WebGL 离线降级

### `index.html`（MC）

- 大小：`49,769` 字节
- 行数：`1682`
- 单文件 HTML
- 包含：
  - Three.js 网页 Minecraft 风格 Demo
  - 随机起伏地形
  - 第一人称鼠标视角
  - WASD 移动 / 空格跳跃
  - 左键放置 / 右键破坏方块
  - 1-7 / 滚轮选方块
  - 经典全局 Three.js 构建，`file://` 可直接打开

## Session 明细（`_pro-test1` 黑洞）

```json
{
  "source": "demo/blackhole/session.jsonl",
  "artifact": "demo/blackhole/blackhole.html",
  "steps": 101,
  "toolCalls": 102,
  "toolBreakdown": {
    "pwsh": 63,
    "str_replace_editor": 39
  },
  "reasoningBlocks": 98,
  "we": 411,
  "lets": 383,
  "letMe": 6,
  "i": 132,
  "markerFirstLine": 1,
  "visibleReplies": 1,
  "durationMs": 1741041,
  "tokens": {
    "input": 37888,
    "output": 118394,
    "reasoning": 80046,
    "cacheRead": 9358464
  }
}
```

## Session 明细（`_pro-test` MC）

```json
{
  "source": "demo/mc/session.jsonl",
  "artifact": "demo/mc/index.html",
  "steps": 168,
  "toolCalls": 167,
  "toolBreakdown": {
    "pwsh": 75,
    "str_replace_editor": 92
  },
  "reasoningBlocks": 162,
  "we": 525,
  "lets": 539,
  "letMe": 4,
  "i": 102,
  "markerFirstLine": 5,
  "visibleReplies": 1,
  "durationMs": 3249186
}
```

## 结论

- 黑洞任务在 coding 模式下由 Pro 独立完成，产物为单文件、功能完整、含离线降级方案。
- MC 任务同样由 Pro 独立完成，产物为单文件 Minecraft 风格 Demo。
- 从词频看：
  - 黑洞：`we` 411、`let's` 383、`let me` 仅 6
  - MC：`we` 525、`let's` 539、`let me` 仅 4
- 两个任务都保持“直接协作干活”轨迹，`let me` 出现极少。
- 两个任务都属于长链路实现测试（黑洞约 29 分钟，MC 约 54 分钟）。
