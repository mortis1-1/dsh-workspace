/**
 * dsh-workspace —— 让 DSH 工作区自带 Copilot 式约定
 *
 * 约定目录：<workspace>/.dsh/
 *   instructions.md   工作区指令，自动注入系统提示（也认 .dsh/AGENTS.md）
 *   hooks.json        PreToolUse / PostToolUse 命令钩子（Copilot hooks 协议）
 *   rules.json        工作区级路径规则（deny 拒绝 / warn 只记日志）
 *
 * 工作区根：从会话 cwd 向上找第一个含 .dsh/ 的目录（最多 8 层）。
 * 缓存：按文件 mtime 失效，改文件即生效，不用重启。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const name = "dsh-workspace";
export const inject = ["systemPrompt", "tools", "commands"];

const DEFAULT_CONFIG = {
  dirName: ".dsh",
  instructionsFiles: ["instructions.md", "AGENTS.md"],
  hooksFile: "hooks.json",
  rulesFile: "rules.json",
  maxInstructionsChars: 32_000,
  maxRootHops: 8,
  defaultHookTimeoutSec: 10,
};

const MUTATING_TOOL =
  /^(write|edit|ops_replace|apply_patch|multiedit|delete|create|move|copy|bash|shell|run_command)/i;

const workspaceCache = new Map();
const rootCache = new Map();
const globCache = new Map();
const warned = new Set();

function warnOnce(ctx, key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  try {
    ctx?.logger?.warn?.(`dsh-workspace: ${message}`);
  } catch {
    /* ignore */
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function readJson(file) {
  try {
    return { value: JSON.parse(fs.readFileSync(file, "utf8")), error: null };
  } catch (err) {
    if (err && err.code === "ENOENT") return { value: null, error: null };
    return { value: null, error: String(err) };
  }
}

/** 会话所属工作区根：向上找带 .dsh/ 的目录；遇到 .git 就停（那是仓库根）。 */
export function resolveWorkspaceRoot(cwd, config = DEFAULT_CONFIG) {
  if (typeof cwd !== "string" || cwd.length === 0) return null;
  const start = path.resolve(cwd);
  const cached = rootCache.get(start);
  if (cached !== undefined) return cached;
  let dir = start;
  let found = null;
  for (let i = 0; i < config.maxRootHops; i++) {
    if (fs.existsSync(path.join(dir, config.dirName))) {
      found = dir;
      break;
    }
    if (fs.existsSync(path.join(dir, ".git"))) {
      // 仓库根没有再往上找的必要，约定就挂在这里
      found = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const resolved = found ?? start;
  // 只缓存「找到了」的结果：之后新建 .dsh 还能被发现
  if (found !== null) rootCache.set(start, resolved);
  return resolved;
}

/** 从会话里拿工作区根。 */
export function sessionWorkspace(session, config = DEFAULT_CONFIG) {
  const cwd = session?.header?.cwd;
  return resolveWorkspaceRoot(cwd, config);
}

function firstText(files) {
  for (const file of files) {
    const text = readText(file);
    if (text.trim().length > 0) return { file, text };
  }
  return { file: null, text: "" };
}

/** 读工作区约定；任何文件变化都会让缓存失效。 */
export function loadWorkspace(root, config = DEFAULT_CONFIG, ctx = null) {
  if (!root) {
    return { root: null, dir: null, instructions: "", instructionsFile: null, truncated: false, hooks: null, rules: null };
  }
  const base = path.join(root, config.dirName);
  // 没有 .dsh/ 就别去 stat 七个文件（大多数工作区都是这种情况）
  if (!fs.existsSync(base)) {
    const empty = { root, dir: base, instructions: "", instructionsFile: null, truncated: false, hooks: null, rules: null };
    workspaceCache.set(base, { stamp: "missing", value: empty });
    return empty;
  }
  const instructionFiles = config.instructionsFiles.map((f) => path.join(base, f));
  const hooksFile = path.join(base, config.hooksFile);
  const rulesFile = path.join(base, config.rulesFile);
  const files = [...instructionFiles, hooksFile, rulesFile];

  const stamp = files
    .map((f) => {
      try {
        return fs.statSync(f).mtimeMs;
      } catch {
        return 0;
      }
    })
    .join(":");
  const hit = workspaceCache.get(base);
  if (hit && hit.stamp === stamp) return hit.value;

  const picked = firstText(instructionFiles);
  const hooks = readJson(hooksFile);
  const rules = readJson(rulesFile);
  if (hooks.error) warnOnce(ctx, `hooks:${base}`, `${config.hooksFile} 解析失败（已忽略）：${hooks.error}`);
  if (rules.error) warnOnce(ctx, `rules:${base}`, `${config.rulesFile} 解析失败（已忽略）：${rules.error}`);

  const truncated = picked.text.length > config.maxInstructionsChars;
  const value = {
    root,
    dir: base,
    instructions: picked.text.slice(0, config.maxInstructionsChars),
    instructionsFile: picked.file ? path.relative(root, picked.file).replace(/\\/g, "/") : null,
    truncated,
    hooks: hooks.value,
    rules: rules.value,
  };
  workspaceCache.set(base, { stamp, value });
  return value;
}

export function clearCache() {
  workspaceCache.clear();
  rootCache.clear();
  globCache.clear();
  warned.clear();
}

/** 极简 glob：`**` 跨目录，`*` 单层，`?` 一个字符；编译结果缓存。 */
export function globToRegExp(glob) {
  const key = String(glob);
  const cached = globCache.get(key);
  if (cached) return cached;
  const norm = key.replace(/\\/g, "/");
  let out = "^";
  for (let i = 0; i < norm.length; i++) {
    const c = norm[i];
    if (c === "*") {
      if (norm[i + 1] === "*") {
        i++;
        if (norm[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  const re = new RegExp(out + "$", "i");
  globCache.set(key, re);
  return re;
}

export function matchesAny(target, globs) {
  if (!target) return null;
  const norm = String(target).replace(/\\/g, "/");
  for (const g of globs || []) {
    let re;
    try {
      re = globToRegExp(g);
    } catch {
      continue;
    }
    if (re.test(norm) || re.test(norm + "/")) return g;
  }
  return null;
}

function hookList(hooks, name) {
  const list = hooks && hooks[name];
  return Array.isArray(list) ? list : [];
}

/** /workspace 用：把钩子条目列出来（命令截断到 80 字符）。 */
function describeHooks(hooks) {
  const lines = [];
  const fmt = (spec) => {
    const cmd = typeof spec === "string" ? spec : spec?.command;
    const flags = [];
    if (spec?.enforce === true) flags.push("enforce");
    if (Array.isArray(spec?.tools) && spec.tools.length > 0) flags.push(`tools=${spec.tools.join("|")}`);
    const prefix = flags.length > 0 ? `[${flags.join(",")}] ` : "";
    return `  - ${prefix}${String(cmd || "?").slice(0, 80)}`;
  };
  for (const key of ["PreToolUse", "PostToolUse"]) {
    const list = hookList(hooks, key);
    if (list.length === 0) continue;
    lines.push(`${key}:`);
    for (const spec of list) lines.push(fmt(spec));
  }
  return lines;
}

function argsOf(exec) {
  const a = exec && exec.arguments;
  return a && typeof a === "object" ? a : {};
}

function firstString(...values) {
  for (const v of values) if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

function targetPath(args) {
  return firstString(args.file_path, args.filePath, args.path, args.target, args.destination);
}

const MAX_PAYLOAD_STRING = 8000;

/** 钩子载荷：大字段截断，避免把整个文件内容塞进子进程 stdin。 */
export function hookPayload(exec, extra = {}) {
  const input = {};
  for (const [key, value] of Object.entries(argsOf(exec))) {
    if (typeof value === "string" && value.length > MAX_PAYLOAD_STRING) {
      input[key] = `${value.slice(0, MAX_PAYLOAD_STRING)}…[truncated ${value.length - MAX_PAYLOAD_STRING} chars]`;
    } else {
      input[key] = value;
    }
  }
  return JSON.stringify({ tool_name: exec?.name, tool_input: input, ...extra });
}

/**
 * 工作区 rules：默认「提示优先」——deny 规则只记 warn 放行；
 * 只有在 rules.json 写 `"enforcement": "strict"` 时才真的拒绝。
 * 只对写盘类工具生效。
 */
export function rulesVerdict(toolName, args, rules, ctx = null) {
  if (!rules) return { action: null };
  if (!MUTATING_TOOL.test(String(toolName || ""))) return { action: null };
  const target = targetPath(args);
  if (!target) return { action: null };
  // allow 优先级最高：deny 目录里要放行的个别文件（比如 data/raw/README.md）
  const allow = matchesAny(target, rules.allow || []);
  if (allow) return { action: "allow", rule: allow, target };
  const strict = rules.enforcement === "strict";
  const deny = matchesAny(target, rules.deny || []);
  if (deny) {
    if (strict) {
      return { action: "deny", rule: deny, target, reason: `[workspace] ${target} 命中工作区禁止规则 ${deny}` };
    }
    try {
      ctx?.logger?.warn?.(`dsh-workspace: [advisory] ${target} 命中禁止规则 ${deny}（仅提醒，未拦截）`);
    } catch {
      /* ignore */
    }
    return { action: "warn", rule: deny, target };
  }
  const warn = matchesAny(target, rules.warn || []);
  if (warn) {
    try {
      ctx?.logger?.warn?.(`dsh-workspace: ${target} 命中工作区提醒规则 ${warn}`);
    } catch {
      /* ignore */
    }
    return { action: "warn", rule: warn, target };
  }
  return { action: null };
}

/** 跑一个钩子命令：JSON 走 stdin，退出码 2 表示拒绝，stderr 作为理由。 */
export function runHook(cwd, spec, payload, config = DEFAULT_CONFIG) {
  const command = typeof spec === "string" ? spec : spec?.command;
  if (!command) return { status: 0, stdout: "", stderr: "" };
  const timeout = Math.max(1, Number(spec?.timeout ?? config.defaultHookTimeoutSec)) * 1000;
  try {
    const res = spawnSync(command, {
      cwd,
      shell: true,
      input: payload,
      timeout,
      encoding: "utf8",
      windowsHide: true,
      env: process.env,
    });
    return {
      status: typeof res.status === "number" ? res.status : 0,
      stdout: res.stdout || "",
      stderr: res.stderr || "",
      error: res.error ? String(res.error.message || res.error) : undefined,
    };
  } catch (err) {
    return { status: 0, stdout: "", stderr: "", error: String(err) };
  }
}

/**
 * 钩子执行器可注入：真实宿主跑子进程，测试换假执行器
 * （沙箱里 spawn 管道会被拒，必须能绕开）。
 */
let hookRunner = runHook;
export function setHookRunner(fn) {
  hookRunner = typeof fn === "function" ? fn : runHook;
}
export function getHookRunner() {
  return hookRunner;
}

/** 钩子可以只对某些工具生效：`"tools": ["write","edit"]`（前缀匹配）。 */
function appliesTo(spec, toolName) {
  const only = spec?.tools;
  if (!Array.isArray(only) || only.length === 0) return true;
  const name = String(toolName || "");
  return only.some((t) => typeof t === "string" && t.length > 0 && (name === t || name.startsWith(t)));
}

/**
 * Pre 阶段只处理显式 `"enforce": true` 的钩子。
 * 没写 enforce 的当「提醒」处理——放到调用后跑，只记日志，不拦路。
 */
function preToolDeny(exec, root, ws, ctx, config) {
  const list = hookList(ws.hooks, "PreToolUse");
  if (list.length === 0) return undefined;
  const payload = hookPayload(exec);
  for (const spec of list) {
    if (spec?.enforce !== true) continue;
    if (!appliesTo(spec, exec?.name)) continue;
    const res = hookRunner(root, spec, payload, config);
    if (res?.error) {
      warnOnce(ctx, `hook:${ws.dir}:${spec?.command ?? String(spec)}`, `PreToolUse 执行失败（按放行处理）：${res.error}`);
      continue;
    }
    if (res?.status === 2) {
      const reason = (res.stderr || res.stdout || "blocked by PreToolUse hook").trim();
      return `[workspace] ${reason}`;
    }
  }
  return undefined;
}

/** 提醒型钩子：调用后跑，命中 exit 2 也只记 warn。 */
function runAdvisoryHooks(exec, root, ws, ctx, config) {
  const pre = hookList(ws.hooks, "PreToolUse").filter((s) => s?.enforce !== true && appliesTo(s, exec?.name));
  const post = hookList(ws.hooks, "PostToolUse").filter((s) => appliesTo(s, exec?.name));
  const list = [...pre, ...post];
  if (list.length === 0) return;
  const payload = hookPayload(exec, { phase: pre.includes(list[0]) ? "advisory" : "post" });
  for (const spec of list) {
    const res = hookRunner(root, spec, payload, config);
    if (res?.error) {
      warnOnce(ctx, `adv:${ws.dir}:${spec?.command ?? String(spec)}`, `提醒钩子执行失败：${res.error}`);
      continue;
    }
    if (res?.status === 2) {
      const reason = (res.stderr || res.stdout || "hook reported a problem").trim();
      try {
        ctx?.logger?.warn?.(`dsh-workspace: [advisory] ${exec?.name} — ${reason}`);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 一次工具调用的整体判定：只解析一次工作区，钩子与规则共用。
 * 返回拒绝理由字符串，或 undefined 表示放行。
 */
function evaluateCall(exec, ctx, config) {
  const root = sessionWorkspace(exec?.agent?.session, config);
  if (!root) return undefined;
  const ws = loadWorkspace(root, config, ctx);
  const byHook = preToolDeny(exec, root, ws, ctx, config);
  if (byHook) return byHook;
  const verdict = rulesVerdict(exec?.name, argsOf(exec), ws.rules, ctx);
  return verdict.action === "deny" ? verdict.reason : undefined;
}

function normalizeConfig(userConfig) {
  const config = { ...DEFAULT_CONFIG, ...(userConfig || {}) };
  // 目录名只接受简单的相对名，防止 ../ 或绝对路径把读取点挪走
  const dirName = typeof config.dirName === "string" ? config.dirName.trim() : "";
  config.dirName = dirName && !dirName.includes("..") && !path.isAbsolute(dirName) ? dirName : DEFAULT_CONFIG.dirName;
  const files = Array.isArray(config.instructionsFiles)
    ? config.instructionsFiles.filter((f) => typeof f === "string" && f.length > 0 && !path.isAbsolute(f))
    : [];
  config.instructionsFiles = files.length > 0 ? files : DEFAULT_CONFIG.instructionsFiles;
  config.maxRootHops = Math.max(1, Math.min(32, Number(config.maxRootHops) || DEFAULT_CONFIG.maxRootHops));
  config.defaultHookTimeoutSec = Math.max(
    1,
    Number(config.defaultHookTimeoutSec) || DEFAULT_CONFIG.defaultHookTimeoutSec,
  );
  config.maxInstructionsChars = Math.max(
    1000,
    Math.min(200_000, Number(config.maxInstructionsChars) || DEFAULT_CONFIG.maxInstructionsChars),
  );
  return config;
}

/**
 * /workspace verify：真的起子进程跑一遍配置里的每个钩子，报告退出码和耗时。
 * 注意：会执行用户自己的钩子命令（这正是"真实验证"的意义）。
 */
export function runSelfCheck(root, ws, config) {
  const lines = [`verify: ${root}`];
  const probePayload = JSON.stringify({
    tool_name: "write",
    tool_input: { file_path: path.join(ws.dir, ".verify-probe"), content: "verify" },
    phase: "verify",
  });
  let ran = 0;
  for (const key of ["PreToolUse", "PostToolUse"]) {
    const list = hookList(ws.hooks, key);
    if (list.length === 0) continue;
    lines.push(`${key}:`);
    for (const spec of list) {
      const command = typeof spec === "string" ? spec : spec?.command;
      if (!command) {
        lines.push("  - (空命令，跳过)");
        continue;
      }
      const started = Date.now();
      const res = hookRunner(root, spec, probePayload, config);
      ran += 1;
      const ms = Date.now() - started;
      const flags = [spec?.enforce === true ? "enforce" : "advisory"];
      if (Array.isArray(spec?.tools)) flags.push(`tools=${spec.tools.join("|")}`);
      const detail = res.error
        ? `执行失败：${res.error}`
        : `exit=${res.status}${res.stderr ? `｜${res.stderr.trim().split(/\r?\n/)[0].slice(0, 80)}` : ""}`;
      lines.push(`  - [${flags.join(",")}] ${String(command).slice(0, 60)} → ${detail}（${ms}ms）`);
    }
  }
  lines.push(`ran: ${ran} 个钩子（真实子进程）`);
  if (ws.hooks === null) lines.push("hooks.json: 未配置，没有可验证的钩子");
  return { kind: "success", text: lines.join("\n") };
}

export function apply(ctx, userConfig = {}) {
  const config = normalizeConfig(userConfig);

  // 1) 工作区指令：每次渲染按当前会话 cwd 现读
  try {
    if (typeof ctx?.systemPrompt?.context === "function") {
      ctx.systemPrompt.context({
        name: "dsh-workspace:instructions",
        order: 3245,
        text: (context) => {
          const root = sessionWorkspace(context?.agent?.session, config);
          if (!root) return "";
          const ws = loadWorkspace(root, config, ctx);
          if (!ws.instructions) return "";
          const note = ws.truncated ? `\n\n（已截断，只注入前 ${config.maxInstructionsChars} 字符）` : "";
          return [`Workspace instructions (${ws.instructionsFile}):`, ws.instructions.trim()].join("\n\n") + note;
        },
      });
    } else {
      warnOnce(ctx, "context-api", "systemPrompt.context 不可用，工作区指令不会注入");
    }
  } catch (err) {
    warnOnce(ctx, "context-register", `工作区指令注册失败: ${String(err)}`);
  }

  // 2) 写盘前：PreToolUse 钩子 + 工作区 rules（工作区只解析一次）
  try {
    if (typeof ctx?.tools?.guard === "function") {
      ctx.tools.guard((exec) => {
        try {
          return evaluateCall(exec, ctx, config);
        } catch (err) {
          warnOnce(ctx, "guard-error", `guard 内部错误（按放行处理）：${String(err)}`);
          return undefined;
        }
      });
    } else {
      warnOnce(ctx, "guard-api", "tools.guard 不可用，PreToolUse 钩子未生效");
    }
  } catch (err) {
    warnOnce(ctx, "guard-register", `PreToolUse 注册失败: ${String(err)}`);
  }

  // 3) 调用后：PostToolUse + 没写 enforce 的 PreToolUse（提醒型）
  try {
    if (typeof ctx?.on === "function") {
      ctx.on("tools/post-execute", async (exec, result, next) => {
        const downstream = await next();
        try {
          const root = sessionWorkspace(exec?.agent?.session, config);
          if (!root) return downstream;
          const ws = loadWorkspace(root, config, ctx);
          runAdvisoryHooks(exec, root, ws, ctx, config);
        } catch {
          /* 后处理失败不影响工具结果 */
        }
        return downstream;
      });
    }
  } catch (err) {
    warnOnce(ctx, "post-register", `PostToolUse 注册失败: ${String(err)}`);
  }

  // 4) /workspace：看加载了什么；/workspace reload 清缓存
  try {
    if (typeof ctx?.commands?.register === "function") {
      ctx.commands.register({
        name: "workspace",
        description: "查看当前工作区加载的 .dsh 约定（reload 可清缓存）",
        input: { hint: "reload | verify" },
        handler(invocation) {
          try {
            const root = sessionWorkspace(invocation?.agent?.session, config) || process.cwd();
            const sub = String(invocation?.rawInput || "").trim();
            if (sub.startsWith("reload")) clearCache();
            const ws = loadWorkspace(root, config, ctx);
            if (sub.startsWith("verify")) return runSelfCheck(root, ws, config);
            const counts = (key) => hookList(ws.hooks, key).length;
            const enforced = hookList(ws.hooks, "PreToolUse").filter((s) => s?.enforce === true).length;
            const mode = ws.rules?.enforcement === "strict" ? "strict（规则会硬拦）" : "advisory（规则只提醒）";
            const lines = [
              `workspace: ${root}`,
              `dir: ${ws.dir}`,
              `instructions: ${ws.instructions ? `${ws.instructions.length} 字符（${ws.instructionsFile}）` : "未找到"}`,
              `mode: ${mode}`,
              `hooks: PreToolUse ${counts("PreToolUse")}（硬拦 ${enforced}）/ PostToolUse ${counts("PostToolUse")}`,
              ...describeHooks(ws.hooks),
              `rules: deny ${(ws.rules?.deny || []).length} / warn ${(ws.rules?.warn || []).length} / allow ${(ws.rules?.allow || []).length}`,
              `skills: ${fs.existsSync(path.join(ws.dir, "skills")) ? "存在（由 DSH 原生技能加载器读取）" : "未找到"}`,
            ];
            if (ws.hooks === null) lines.push("hooks.json: 未配置");
            return { kind: "success", text: lines.join("\n") };
          } catch (err) {
            return { kind: "error", text: `dsh-workspace: /workspace 读取失败：${String(err)}` };
          }
        },
      });
    }
  } catch (err) {
    warnOnce(ctx, "command-register", `/workspace 注册失败: ${String(err)}`);
  }
}
