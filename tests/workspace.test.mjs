/**
 * dsh-workspace 的行为测试：用假 ctx + 临时工作区，
 * 钉住「指令注入 / PreToolUse 拦截 / PostToolUse 后处理 / 工作区规则」四条。
 *
 * 注意：沙箱里子进程管道会被拒（EPERM），所以钩子执行器用假的；
 * 真实宿主里走 runHook（子进程 + stdin JSON），那条路径单独用「坏命令不抛」覆盖。
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mod = await import("../lib/index.js");

const hookCalls = [];
const fakeRunner = (cwd, spec, payload) => {
  hookCalls.push({ cwd, spec, payload });
  if (spec?.writeFile) fs.writeFileSync(path.join(cwd, spec.writeFile), spec.writeContent ?? "ok");
  return { status: spec?.status ?? 0, stdout: "", stderr: spec?.stderr ?? "" };
};
mod.setHookRunner(fakeRunner);

function makeWorkspace({ instructions, hooks, rules } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ws-"));
  const dsh = path.join(dir, ".dsh");
  fs.mkdirSync(dsh, { recursive: true });
  if (instructions !== undefined) fs.writeFileSync(path.join(dsh, "instructions.md"), instructions);
  if (hooks !== undefined) fs.writeFileSync(path.join(dsh, "hooks.json"), JSON.stringify(hooks, null, 2));
  if (rules !== undefined) fs.writeFileSync(path.join(dsh, "rules.json"), JSON.stringify(rules, null, 2));
  return dir;
}

function makeCtx() {
  const seen = { contexts: [], guards: [], listeners: [], commands: [] };
  const ctx = {
    logger: { warn: () => {} },
    systemPrompt: {
      context: (def) => {
        seen.contexts.push(def);
        return () => {};
      },
    },
    tools: {
      guard: (fn) => {
        seen.guards.push(fn);
        return () => {};
      },
    },
    on: (event, fn) => {
      seen.listeners.push([event, fn]);
      return () => {};
    },
    commands: {
      register: (def) => {
        seen.commands.push(def);
        return () => {};
      },
    },
  };
  return { ctx, seen };
}

const sessionFor = (cwd) => ({ agent: { session: { header: { cwd } } } });
const execFor = (cwd, name, args) => ({ name, arguments: args, agent: { session: { header: { cwd } } } });

const { ctx, seen } = makeCtx();
mod.apply(ctx);
const guard = seen.guards[0];
const contextDef = seen.contexts[0];
const postListener = seen.listeners.find(([evt]) => evt === "tools/post-execute")?.[1];
const workspaceCmd = seen.commands.find((c) => c.name === "workspace");

test("declares every service it touches", () => {
  for (const svc of ["systemPrompt", "tools", "commands"]) {
    assert.ok(mod.inject.includes(svc), `inject 必须声明 ${svc}`);
  }
});

test("registers the three seams", () => {
  assert.equal(seen.contexts.length, 1, "systemPrompt.context");
  assert.equal(seen.guards.length, 1, "tools.guard");
  assert.ok(postListener, "tools/post-execute");
  assert.ok(workspaceCmd, "/workspace command");
});

test("instructions are injected for the active workspace", () => {
  const dir = makeWorkspace({ instructions: "# 规则\n- 先写 WORKLOG\n- 数字必须可反算\n" });
  const text = contextDef.text(sessionFor(dir));
  assert.match(text, /先写 WORKLOG/);
  assert.match(text, /instructions\.md/);
  assert.equal(contextDef.text(sessionFor(os.tmpdir())), "");
});

test("instructions are re-read after the file changes", async () => {
  const dir = makeWorkspace({ instructions: "旧内容" });
  assert.match(contextDef.text(sessionFor(dir)), /旧内容/);
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(path.join(dir, ".dsh", "instructions.md"), "新内容");
  assert.match(contextDef.text(sessionFor(dir)), /新内容/);
});

test("PreToolUse hook exiting 2 denies the call", () => {
  const dir = makeWorkspace({
    hooks: { PreToolUse: [{ command: "deny", status: 2, stderr: "不许动 data/raw", enforce: true }] },
  });
  const reason = guard(execFor(dir, "write", { file_path: path.join(dir, "a.txt") }));
  assert.equal(typeof reason, "string");
  assert.match(reason, /不许动 data\/raw/);
});

test("PreToolUse hook exiting 0 allows the call", () => {
  const dir = makeWorkspace({ hooks: { PreToolUse: [{ command: "ok", status: 0 }] } });
  assert.equal(guard(execFor(dir, "write", { file_path: path.join(dir, "a.txt") })), undefined);
});

test("PreToolUse receives tool name and arguments as JSON", () => {
  const dir = makeWorkspace({ hooks: { PreToolUse: [{ command: "echo", status: 0, enforce: true }] } });
  hookCalls.length = 0;
  guard(execFor(dir, "ops_bash", { command: "ls" }));
  const call = hookCalls.find((c) => c.cwd === dir);
  assert.ok(call);
  const payload = JSON.parse(call.payload);
  assert.equal(payload.tool_name, "ops_bash");
  assert.equal(payload.tool_input.command, "ls");
});

test("workspace rules deny writes to listed globs", () => {
  const dir = makeWorkspace({ rules: { deny: ["**/secrets/**"], warn: [], enforcement: "strict" } });
  const denied = guard(execFor(dir, "write", { file_path: path.join(dir, "secrets", "k.txt") }));
  assert.equal(typeof denied, "string");
  assert.match(denied, /secrets/);
  assert.equal(guard(execFor(dir, "read", { file_path: path.join(dir, "secrets", "k.txt") })), undefined);
});

test("PostToolUse hook runs after the call", async () => {
  const dir = makeWorkspace({
    hooks: { PostToolUse: [{ command: "mark", writeFile: "marker.txt", writeContent: "ok" }] },
  });
  const res = await postListener(execFor(dir, "write", { file_path: "a.txt" }), {}, async () => ({ kind: "accept" }));
  assert.equal(res.kind, "accept");
  const marker = path.join(dir, "marker.txt");
  assert.ok(fs.existsSync(marker), "PostToolUse 应该真的跑了");
  assert.match(fs.readFileSync(marker, "utf8"), /ok/);
});

test("/workspace reports what got loaded", () => {
  const dir = makeWorkspace({
    instructions: "x",
    hooks: { PreToolUse: [{}], PostToolUse: [{}] },
    rules: { deny: ["**/a/**", "**/b/**"], warn: ["**/.env"] },
  });
  const out = workspaceCmd.handler({ agent: { session: { header: { cwd: dir } } } });
  assert.equal(out.kind, "success");
  assert.match(out.text, /hooks: PreToolUse 1（硬拦 0）\/ PostToolUse 1/);
  assert.match(out.text, /rules: deny 2 \/ warn 1/);
});

test("no .dsh directory means no interference", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ws-empty-"));
  assert.equal(contextDef.text(sessionFor(dir)), "");
  assert.equal(guard(execFor(dir, "write", { file_path: path.join(dir, "a.txt") })), undefined);
});

test("runHook never throws on a bad command", () => {
  const res = mod.runHook(os.tmpdir(), { command: "definitely-not-a-real-command-xyz" }, "{}");
  assert.equal(typeof res, "object");
  assert.equal(typeof res.status, "number");
});

// ---- 优化后新增：根发现 / AGENTS 回落 / warn / 坏 JSON / reload / 钩子失败 ----

test("workspace root is found from a nested cwd", () => {
  const dir = makeWorkspace({ instructions: "根目录的约定" });
  const nested = path.join(dir, "src", "deep");
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(mod.resolveWorkspaceRoot(nested), dir);
  assert.match(contextDef.text(sessionFor(nested)), /根目录的约定/);
});

test("falls back to .dsh/AGENTS.md when instructions.md is missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ws-agents-"));
  fs.mkdirSync(path.join(dir, ".dsh"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".dsh", "AGENTS.md"), "来自 AGENTS");
  const text = contextDef.text(sessionFor(dir));
  assert.match(text, /来自 AGENTS/);
  assert.match(text, /AGENTS\.md/);
});

test("rules warn does not deny", () => {
  const dir = makeWorkspace({ rules: { deny: [], warn: ["**/.env"] } });
  assert.equal(guard(execFor(dir, "write", { file_path: path.join(dir, ".env") })), undefined);
});

test("broken hooks.json is ignored instead of crashing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ws-bad-"));
  fs.mkdirSync(path.join(dir, ".dsh"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".dsh", "hooks.json"), "{ not json");
  assert.equal(guard(execFor(dir, "write", { file_path: path.join(dir, "a.txt") })), undefined);
});

test("/workspace reload clears the cache", () => {
  const dir = makeWorkspace({ instructions: "v1" });
  assert.match(contextDef.text(sessionFor(dir)), /v1/);
  // 同 mtime 内的写入不会让缓存失效，reload 强制重读
  fs.writeFileSync(path.join(dir, ".dsh", "instructions.md"), "v2");
  const out = workspaceCmd.handler({ rawInput: "reload", agent: { session: { header: { cwd: dir } } } });
  assert.equal(out.kind, "success");
  assert.match(contextDef.text(sessionFor(dir)), /v2/);
});

test("a failing hook runner is fail-open, not fail-closed", () => {
  const dir = makeWorkspace({
    hooks: { PreToolUse: [{ command: "boom", error: "EPERM", enforce: true }] },
  });
  assert.equal(guard(execFor(dir, "write", { file_path: path.join(dir, "a.txt") })), undefined);
});

// ---- 第 2 轮：载荷截断 / tools 过滤 / 截断告知 / .git 边界 ----

test("hook payload truncates huge arguments", () => {
  const big = "x".repeat(20_000);
  const payload = JSON.parse(mod.hookPayload({ name: "write", arguments: { file_path: "a.txt", content: big } }));
  assert.ok(payload.tool_input.content.length < 9000);
  assert.match(payload.tool_input.content, /truncated/);
  assert.equal(payload.tool_input.file_path, "a.txt");
});

test("hook 'tools' filter skips unrelated tools", () => {
  const dir = makeWorkspace({
    hooks: { PreToolUse: [{ command: "deny-write", status: 2, stderr: "只拦 write", tools: ["write"], enforce: true }] },
  });
  // write 命中 → 拒绝
  assert.equal(typeof guard(execFor(dir, "write", { file_path: path.join(dir, "a.txt") })), "string");
  // bash 不在过滤里 → 放行
  assert.equal(guard(execFor(dir, "ops_bash", { command: "echo hi" })), undefined);
});

test("oversized instructions are truncated and the injection says so", () => {
  const dir = makeWorkspace({ instructions: "A".repeat(40_000) });
  const text = contextDef.text(sessionFor(dir));
  assert.match(text, /已截断/);
  assert.ok(text.length < 34_000);
});

test("walking up stops at a .git repository root", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ws-repo-"));
  fs.mkdirSync(path.join(repo, ".git"));
  const nested = path.join(repo, "pkg", "src");
  fs.mkdirSync(nested, { recursive: true });
  // 仓库根没有 .dsh，就不要继续往上爬到别的目录去
  assert.equal(mod.resolveWorkspaceRoot(nested), repo);
});

test("config rejects path-traversal dirName", () => {
  const { ctx: c, seen: s } = makeCtx();
  mod.apply(c, { dirName: "../../etc" });
  assert.equal(s.contexts.length, 1);
  // 渲染时仍按默认 .dsh 解析，不会去读 ../../
  const text = s.contexts[0].text(sessionFor(os.tmpdir()));
  assert.equal(text, "");
});



// ---- 提示优先（advisory）默认行为 ----

test("rules deny only warns by default (advisory mode)", () => {
  const dir = makeWorkspace({ rules: { deny: ["**/secrets/**"] } });
  assert.equal(guard(execFor(dir, "write", { file_path: path.join(dir, "secrets", "k.txt") })), undefined);
});

test("PreToolUse without enforce runs after the call and does not block", async () => {
  const dir = makeWorkspace({
    hooks: { PreToolUse: [{ command: "advisory", status: 2, stderr: "提醒一下" }] },
  });
  assert.equal(guard(execFor(dir, "write", { file_path: path.join(dir, "a.txt") })), undefined);
  hookCalls.length = 0;
  await postListener(execFor(dir, "write", { file_path: path.join(dir, "a.txt") }), {}, async () => ({ kind: "accept" }));
  assert.ok(hookCalls.some((c) => c.cwd === dir), "提醒钩子应该在调用后跑");
});

test("/workspace reports the enforcement mode", () => {
  const strictDir = makeWorkspace({ rules: { deny: ["**/a/**"], enforcement: "strict" } });
  const strictOut = workspaceCmd.handler({ agent: { session: { header: { cwd: strictDir } } } });
  assert.match(strictOut.text, /mode: strict/);
  const advDir = makeWorkspace({ rules: { deny: ["**/a/**"] } });
  const advOut = workspaceCmd.handler({ agent: { session: { header: { cwd: advDir } } } });
  assert.match(advOut.text, /mode: advisory/);
});

// ---- allow 例外 / /workspace 明细 ----

test("rules allow wins over deny even in strict mode", () => {
  const dir = makeWorkspace({
    rules: { enforcement: "strict", deny: ["**/data/raw/**"], allow: ["**/data/raw/README.md"] },
  });
  assert.equal(guard(execFor(dir, "write", { file_path: path.join(dir, "data", "raw", "README.md") })), undefined);
  assert.equal(typeof guard(execFor(dir, "write", { file_path: path.join(dir, "data", "raw", "a.csv") })), "string");
});

test("/workspace lists hook commands and allow count", () => {
  const dir = makeWorkspace({
    hooks: {
      PreToolUse: [{ command: "guard-raw.ps1", enforce: true, tools: ["write"] }],
      PostToolUse: [{ command: "format.ps1" }],
    },
    rules: { allow: ["**/README.md"], deny: [], warn: [] },
  });
  const out = workspaceCmd.handler({ agent: { session: { header: { cwd: dir } } } });
  assert.match(out.text, /PreToolUse:/);
  assert.match(out.text, /\[enforce,tools=write\] guard-raw\.ps1/);
  assert.match(out.text, /PostToolUse:/);
  assert.match(out.text, /allow 1/);
});

test("/workspace verify reports each hook's exit code", () => {
  const dir = makeWorkspace({
    hooks: {
      PreToolUse: [{ command: "ok-hook", status: 0 }],
      PostToolUse: [{ command: "warn-hook", status: 2, stderr: "注意" }],
    },
  });
  const out = workspaceCmd.handler({ rawInput: "verify", agent: { session: { header: { cwd: dir } } } });
  assert.equal(out.kind, "success");
  assert.match(out.text, /ran: 2 个钩子/);
  assert.match(out.text, /exit=0/);
  assert.match(out.text, /exit=2/);
  assert.match(out.text, /注意/);
});
