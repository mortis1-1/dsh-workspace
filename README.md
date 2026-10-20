# dsh-workspace

把 Copilot 那套**工作区约定**搬进 DSH：装一次，之后每个工作区自己带规则。

## 约定目录

工作区根目录下建 `.dsh/`：

```
.dsh/
  instructions.md     ← 工作区指令，自动注入系统提示（等价 copilot-instructions.md）
  AGENTS.md           ← instructions.md 不存在时回落到它
  hooks.json          ← PreToolUse / PostToolUse 命令钩子（Copilot hooks 协议）
  rules.json          ← 工作区级路径规则（只拦写盘类工具）
  skills/<名字>/SKILL.md   ← 技能（交给 DSH 原生技能加载器，本插件不重复实现）
```

**工作区根**从会话 cwd 往上找第一个含 `.dsh/` 的目录（最多 8 层），子目录里开会话也能吃到仓库根的约定。

## instructions.md

会话开始时按当前工作区读入，注入系统提示；文件改了下一轮就生效（按 mtime 缓存，不用重启）。

```markdown
# 本工作区约定
- 先建 WORKLOG，再开工
- 数字必须能反算
```

## hooks.json

和 Copilot 的 hooks 一样：命令从 **stdin 收 JSON**（`{"tool_name":..., "tool_input":...}`），**退出码 2 报告问题**，`stderr` 作为理由；退出码 0 通过。

**默认提示优先**：PreToolUse 条目没写 `"enforce": true` 时**不会拦路**——它在调用之后跑，exit 2 只记一条 warn。只有显式写 `enforce` 才会在调用前拒绝。

```json
{
  "PreToolUse": [
    { "command": "powershell -File .dsh/hooks/guard-raw.ps1", "timeout": 10, "enforce": true },
    { "command": "powershell -File .dsh/hooks/advise.ps1", "timeout": 10 }
  ],
  "PostToolUse": [
    { "command": "powershell -File .dsh/hooks/format.ps1", "timeout": 60 }
  ]
}
```

- `enforce: true` → 走 `tools.guard`，同步拒绝
- 没写 `enforce` → 调用后跑（`tools/post-execute`），只提醒
- **失败策略是 fail-open**：钩子超时、命令不存在、JSON 写坏 —— 一律记一条 warn 并放行，不把工作区锁死
- **超时**：默认 10 秒，可被条目里的 `timeout` 覆盖
- **只对某些工具生效**：条目里加 `"tools": ["write", "edit"]`（前缀匹配），不相关的调用不会白开子进程
- **载荷有上限**：单个字符串参数超过 8000 字符会截断并标注，避免把整篇文件塞进子进程 stdin

## rules.json

不用写脚本的轻量规则，只对写盘类工具生效：

```json
{ "deny": ["**/data/raw/**"], "allow": ["**/data/raw/README.md"], "warn": ["**/.env"] }
```

- **默认 advisory**：`deny` 命中只记 warn（`ctx.logger.warn`），不拦路
- **要硬拦**：写 `"enforcement": "strict"`，`deny` 才真的拒绝
- **`allow` 优先级最高**：deny 目录里要放行的个别文件写在 allow 里（strict 也生效）
- `warn` 永远是只记日志
- glob 编译结果有缓存，热路径不重复构造正则

## /workspace

输入 `/workspace` 看当前工作区加载了什么：根目录、指令来源与长度、**当前 enforcement 模式**、每条钩子的命令与 flag（`[enforce,tools=write]`）、规则条数（deny/warn/allow）、技能目录是否存在。
输入 `/workspace reload` 会清掉缓存强制重读（正常改文件不需要，按 mtime 自动失效）。
输入 `/workspace verify` 会**真实启动子进程**跑一遍配置里的每个钩子，报告退出码、耗时和首行 stderr —— 这是真验证，不是模拟。

## 与 dsh-hookd 的分工

- **dsh-hookd**：全局安全闸（跨工作区），审计每次调用、拦红线路径。
- **dsh-workspace**：工作区约定（跟着仓库走），指令 + 钩子 + 工作区规则。

两者都返回字符串拒绝，宿主侧都会拦；先触发哪个看注册顺序，不会互相放行。

## 安装

插件页 → 添加插件 → 本地目录 → 选本目录 → 重启 DSH。
