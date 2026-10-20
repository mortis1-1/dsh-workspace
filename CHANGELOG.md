# Changelog

## 0.1.0 — 2026-10-20

首个版本：把 Copilot 式工作区约定搬进 DSH。

**提示优先（advisory）是默认行为**

- **规则** `.dsh/rules.json`：`deny` 默认只记 warn 不拦路；要硬拦写 `"enforcement": "strict"`。`allow` 优先级最高（deny 目录里放行个别文件）；`warn` 永远只记日志。
- **钩子** `.dsh/hooks.json`：`PreToolUse` 条目默认“调用后跑、只提醒”；显式 `"enforce": true` 才在调用前拒绝。`PostToolUse` 照常。
- 理由：约定层是给人看的，不是给工具撞的；硬拦只留给真正需要（原始数据、发布物）。

**功能**

- **指令**：`.dsh/instructions.md`（回落 `.dsh/AGENTS.md`）注入系统提示；按 mtime 缓存，改完即生效；超长截断并在注入内容里注明。
- **钩子协议**：Copilot 兼容（stdin 收 JSON，exit 2 报告问题，stderr 作理由）；支持 `timeout`、`tools` 过滤、`enforce`；载荷单字段超 8000 字符截断。
- **工作区根**：从会话 cwd 向上找带 `.dsh/` 的目录，遇 `.git` 停止；命中结果缓存；没有 `.dsh` 时不做多余 stat。
- **失败策略**：fail-open——钩子超时/命令不存在/JSON 写坏都只 warn 一次并放行，不锁死工作区。
- **命令**：`/workspace` 查看加载情况（含 enforcement 模式、每条钩子的命令与 flag、规则条数）；`/workspace reload` 清缓存；`/workspace verify` **真实起子进程**跑一遍钩子并报告退出码/耗时。

29 个测试（node:test），覆盖注入、根发现、advisory/strict 两种模式、钩子拒绝/放行/提醒、缓存失效、坏配置、载荷截断、工具过滤。
