# Side Dock

贴在桌面屏幕边缘的竖条监视器：**DeepSeek 余额、OpenCode Go 额度（5 小时 / 周 / 月）、今日与本月 token、实时 tok/s、会话列表、CPU / 内存**。
可拖动、松手自动吸附到最近的屏幕边缘，外侧圆角、贴边侧直角，像一个系统侧边栏。

独立桌面应用（Electron），**不依赖 DeepSeek Harness 运行**；它只读取本机的 DSH 会话日志和两个额度接口。

## 功能

- **收起态（边缘条）**：今日 tokens、tok/s、三个额度圆环（环 = 剩余百分比）、DeepSeek 余额、CPU / MEM（带占用条）、会话数、更新时间
- **展开态（详情卡）**：DeepSeek 余额卡、OpenCode Go 三个额度窗口（剩多少 / 已用多少 / 进度条 / 重置倒计时）、今日与本月 tokens、会话列表（每条带上下文占用条）、CPU / MEM / tok/s
- **拖动与磁吸**：按住面板任意空白处拖动，松手时距任意屏幕边缘 ≤56px 即吸附贴边；位置与吸附边持久化
- 明暗主题跟随系统；中文界面

## 数据来源

| 数据 | 来源 |
| --- | --- |
| DeepSeek 余额 | `GET https://api.deepseek.com/user/balance`（Bearer） |
| OpenCode Go 额度 | `GET https://opencode.ai/zen/go/v1/usage`（Bearer） |
| token / 会话 | 本机 DSH 会话日志 `$DSH_HOME/sessions/**/session.v4.jsonl.zstd`（只读解析，多帧 zstd） |
| CPU / 内存 | 系统（macOS 内存用 `vm_stat`，更接近活动监视器口径） |

### API Key 解析顺序（先命中先用）

1. 环境变量：`DEEPSEEK_API_KEY` / `OPENCODE_GO_API_KEY`
2. DSH 凭据库 `~/.dsh/.credentials.yaml` 的 `refs:` 段（只读，复用 DSH 已配置的 key）
3. 本地配置 `~/.side-dock/config.json`：

```json
{
  "deepseekApiKey": "sk-...",
  "opencodeApiKey": "oc_sk_..."
}
```

没有 key 时对应卡片显示「未登录 / 未配置 Key」，不影响其他数据。

## 运行 / 构建

需要 macOS 13+，本机已有 Electron（脚本会自动查找）：

| 查找顺序 | 路径 |
| --- | --- |
| 1 | `$SIDE_DOCK_ELECTRON_APP` |
| 2 | `~/.dsh/electron/Electron.app`（DSH 已下载的 Electron 运行时） |
| 3 | `/Applications/Electron.app` |

```bash
# 1) 直接跑（开发）
npx electron src/main.js            # 或：electron src/main.js

# 2) 只打印一次数据快照（排障）
electron src/main.js --dump-stats

# 3) 打包安装（推荐）
node scripts/build-app.mjs
```

打包会生成两个东西：

| 产物 | 位置 | 说明 |
| --- | --- | --- |
| 启动器 | `~/Desktop/Side Dock.app` | 双击这里；把引擎作为 launchd 作业拉起来 |
| 引擎 | `~/Applications/Side Dock Engine.app` | 真正的 Electron 应用 |

**为什么不是一个单独的 .app**：macOS 26+ 的 LaunchServices 拒绝启动 ad-hoc 签名的 Electron 包（进程立刻以 `LSExitStatus 0` 退出），但直接执行同一个二进制完全正常。所以启动器用 AppleScript 调 `launchctl submit` 启动引擎，双击体验不变；如果你有 Developer ID，也可以只给引擎签名后直接双击引擎。

重装/更新代码：改完 `src/` 后重新跑一次 `node scripts/build-app.mjs`，然后双击桌面启动器（它会先卸掉旧作业再拉起新进程）。

## 目录

```
src/main.js            Electron 主进程：窗口、拖动吸附、2s 轮询、IPC
src/preload.js         IPC 桥
src/renderer/index.html 收起 / 展开两种布局的 UI
src/data/index.js      系统 CPU / 内存 + 快照组装
src/data/dsh.js        DSH 会话日志解析（多帧 zstd → token 统计）
src/data/providers.js  DeepSeek 余额、OpenCode Go 额度、Key 解析
src/geometry.js        吸附 / 边界的纯计算（可单测）
scripts/build-app.mjs  打包引擎 + 桌面启动器
assets/icon.png        应用图标源图
```

## 隐私

- 网络请求只有两个额度接口，不发送任何会话内容
- 会话日志只在本机读取，用于统计 token 数量
- API Key 只存在本机（env / DSH 凭据库 / `~/.side-dock/config.json`），仓库里没有任何密钥

## 致谢

- 界面设计语言参考 [Javis603/token-monitor](https://github.com/Javis603/token-monitor)（MIT）
- 品牌图标来自 [Simple Icons](https://simpleicons.org/)（CC0 1.0）：OpenCode、DeepSeek 商标归各自所有者

## License

MIT
