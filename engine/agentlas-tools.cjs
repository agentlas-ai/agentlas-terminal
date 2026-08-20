"use strict";
/*
 * agentlas-tools: BYOK/Ollama 자체 에이전트 루프가 실행하는 로컬 툴.
 * 권한 모델(read|write|full)을 코드 레벨에서 강제한다 — Claude/Codex의 permission-mode와 동일 의미.
 *   read  : 읽기 전용 (list_dir, read_file)
 *   write : + 파일 생성/편집 (write_file, edit_file)
 *   full  : + 셸 실행 (bash)
 * 위험 동작이 현재 권한을 넘으면 던지지 않고 에러 문자열을 tool_result로 돌려준다(루프 안전).
 */
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const PERM_RANK = { read: 0, write: 1, full: 2 };

function pathDenied(reason) {
  throw new Error(`workspace path denied: ${reason}`);
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function getWorkspaceRoot(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0 || cwd.includes("\0")) {
    pathDenied("working folder is invalid");
  }
  const root = fs.realpathSync(path.resolve(cwd));
  if (!fs.statSync(root).isDirectory()) pathDenied("working folder is not a directory");
  return root;
}

function validateRelativePath(input) {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
    pathDenied("path must be a non-empty string");
  }
  // Check both dialects. A Windows absolute/UNC path must remain invalid even
  // when a request is prepared or tested on a POSIX host (and vice versa).
  if (
    path.isAbsolute(input) ||
    path.posix.isAbsolute(input) ||
    path.win32.isAbsolute(input) ||
    /^[A-Za-z]:/.test(input)
  ) {
    pathDenied("absolute paths are not allowed");
  }
  // Reject traversal before path.resolve() normalizes it away. This deliberately
  // denies `safe/../file`, not only traversal that currently lands outside.
  if (input.split(/[\\/]+/u).some((segment) => segment === "..")) {
    pathDenied("parent traversal is not allowed");
  }
  return input;
}

function lexicalPath(root, input) {
  const candidate = path.resolve(root, validateRelativePath(input));
  if (!contained(root, candidate)) pathDenied("path leaves the working folder");
  return candidate;
}

function resolveExistingIn(cwd, input) {
  const root = getWorkspaceRoot(cwd);
  const candidate = lexicalPath(root, input);
  const real = fs.realpathSync(candidate);
  if (!contained(root, real)) pathDenied("symbolic link leaves the working folder");
  return real;
}

function resolveWritableIn(cwd, input) {
  const root = getWorkspaceRoot(cwd);
  const candidate = lexicalPath(root, input);
  const missing = [];
  let cursor = candidate;

  // lstat (rather than existsSync) notices broken symlinks and makes them fail
  // closed. Resolve the nearest existing ancestor before mkdir can have any
  // side effect outside the workspace.
  while (true) {
    try {
      fs.lstatSync(cursor);
      break;
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) pathDenied("no existing workspace ancestor");
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }

  let realAncestor;
  try {
    realAncestor = fs.realpathSync(cursor);
  } catch (error) {
    if (fs.lstatSync(cursor).isSymbolicLink()) pathDenied("symbolic link target is unavailable");
    throw error;
  }
  if (!contained(root, realAncestor)) pathDenied("symbolic link leaves the working folder");
  const ancestorStat = fs.statSync(realAncestor);
  if (missing.length === 0 && !ancestorStat.isFile()) pathDenied("only regular files may be written");
  if (missing.length > 0 && !ancestorStat.isDirectory()) pathDenied("write parent is not a directory");
  const destination = path.join(realAncestor, ...missing);
  if (!contained(root, destination)) pathDenied("path leaves the working folder");
  return destination;
}

function safeOpenFlags() {
  if (process.platform === "win32") return 0;
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  // Avoid blocking forever if a special file is swapped into place between
  // canonicalization and open; fstat below will then reject it.
  const nonBlock = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
  return noFollow | nonBlock;
}

function openRegularFile(file, flags, mode) {
  const fd = fs.openSync(file, flags | safeOpenFlags(), mode);
  try {
    if (!fs.fstatSync(fd).isFile()) pathDenied("only regular files are allowed");
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function readUtf8File(file) {
  if (!fs.statSync(file).isFile()) pathDenied("only regular files may be read");
  const fd = openRegularFile(file, fs.constants.O_RDONLY);
  try {
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function writeUtf8File(file, content) {
  // Replace through a fresh inode instead of truncating an existing one. If the
  // workspace entry is a hard link to a file elsewhere, this updates only the
  // workspace path and cannot mutate the other link's inode.
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.agentlas-${process.pid}-${crypto.randomUUID()}.tmp`);
  let targetMode = 0o600;
  let targetOwner = null;
  try {
    const existing = fs.statSync(file);
    if (existing.isFile()) {
      targetMode = existing.mode & 0o777;
      targetOwner = { uid: existing.uid, gid: existing.gid };
    }
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  let fd;
  try {
    fd = openRegularFile(
      temp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    fs.writeFileSync(fd, content, "utf8");
    if (targetOwner) {
      try { fs.fchownSync(fd, targetOwner.uid, targetOwner.gid); } catch { /* best-effort ownership preservation */ }
    }
    try { fs.fchmodSync(fd, targetMode); } catch { /* Windows/best-effort */ }
    try { fs.fsyncSync(fd); } catch { /* best-effort durability */ }
    fs.closeSync(fd);
    fd = null;
    try {
      fs.renameSync(temp, file);
    } catch (error) {
      // Windows does not replace an existing destination with renameSync.
      if (!error || !["EEXIST", "EPERM"].includes(error.code)) throw error;
      fs.rmSync(file, { force: true });
      fs.renameSync(temp, file);
    }
  } finally {
    if (fd != null) fs.closeSync(fd);
    try { fs.rmSync(temp, { force: true }); } catch { /* best-effort cleanup */ }
  }
}
function truncate(s, n) {
  s = String(s);
  return s.length <= n ? s : s.slice(0, n) + `\n…(${s.length - n} chars truncated)`;
}

const TOOLS = [
  {
    name: "list_dir",
    minPerm: "read",
    description: "List files and folders in a directory (relative to the working folder).",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path (default: working folder)" } },
    },
    run(args, ctx) {
      const dir = resolveExistingIn(ctx.cwd, args.path || ".");
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const lines = entries
        .slice(0, 400)
        .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
        .sort();
      return `${dir}\n` + lines.join("\n");
    },
  },
  {
    name: "read_file",
    minPerm: "read",
    description: "Read a UTF-8 text file. Optionally from a line offset.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number", description: "1-based start line" },
        limit: { type: "number", description: "max lines" },
      },
      required: ["path"],
    },
    run(args, ctx) {
      const file = resolveExistingIn(ctx.cwd, args.path);
      let content = readUtf8File(file);
      if (args.offset || args.limit) {
        const lines = content.split("\n");
        const start = Math.max(0, (args.offset || 1) - 1);
        const end = args.limit ? start + args.limit : lines.length;
        content = lines.slice(start, end).join("\n");
      }
      return truncate(content, 20000);
    },
  },
  {
    name: "write_file",
    minPerm: "write",
    description: "Create or overwrite a file with the given content.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    run(args, ctx) {
      const file = resolveWritableIn(ctx.cwd, args.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const existed = fs.existsSync(file);
      writeUtf8File(file, args.content);
      return `${existed ? "overwrote" : "created"} ${file} (${args.content.length} bytes)`;
    },
  },
  {
    name: "edit_file",
    minPerm: "write",
    description:
      "Replace an exact substring in a file. old_string must occur exactly once unless replace_all is true.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path", "old_string", "new_string"],
    },
    run(args, ctx) {
      if (args.old_string === "") throw new Error("old_string must be non-empty");
      const file = resolveExistingIn(ctx.cwd, args.path);
      const src = readUtf8File(file);
      if (!src.includes(args.old_string)) throw new Error("old_string not found");
      const count = src.split(args.old_string).length - 1;
      if (!args.replace_all && count > 1) throw new Error(`old_string occurs ${count}× (use replace_all or add context)`);
      const out = args.replace_all
        ? src.split(args.old_string).join(args.new_string)
        : src.replace(args.old_string, args.new_string);
      writeUtf8File(file, out);
      return `edited ${file} (${count} replacement${count > 1 ? "s" : ""})`;
    },
  },
  {
    name: "bash",
    minPerm: "full",
    description: "Run a shell command in the working folder. Requires 'full' permission.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" }, timeout_ms: { type: "number" } },
      required: ["command"],
    },
    run(args, ctx) {
      const t = Number(args.timeout_ms);
      const timeout = Math.min(Math.max(Number.isFinite(t) && t > 0 ? t : 120000, 1000), 600000);
      const res = spawnSync("bash", ["-lc", args.command], {
        cwd: ctx.cwd,
        encoding: "utf8",
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        env: ctx.env || process.env,
      });
      const parts = [];
      if (res.stdout) parts.push(res.stdout);
      if (res.stderr) parts.push(res.stderr);
      // spawnSync는 timeout/maxBuffer/spawn 실패를 status=null + error/signal로 알린다 — 무음 실패 방지.
      let head = `exit ${res.status == null ? "?" : res.status}`;
      if (res.error) {
        head +=
          res.error.code === "ETIMEDOUT"
            ? ` (timed out after ${timeout}ms)`
            : res.error.code === "ENOBUFS"
              ? " (output exceeded 8MB, truncated)"
              : ` (spawn error: ${res.error.message})`;
      } else if (res.signal) {
        head += ` (killed by ${res.signal})`;
      }
      const body = truncate(parts.join("\n").trim() || "(no output)", 12000);
      return `${head}\n${body}`;
    },
  },
];

const BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// 현재 권한에서 허용되는 툴만.
function allowedTools(permission) {
  const rank = PERM_RANK[permission] ?? 0;
  return TOOLS.filter((t) => (PERM_RANK[t.minPerm] ?? 0) <= rank);
}

/*
 * ── 능력 규칙(공유 capability_grants)이 등급보다 먼저다 ──────────────────────
 *
 * 오너 결정(2026-08-20): 승인은 행동 기준이고 데스크탑·터미널이 **공유**한다.
 *  · 데스크탑에서 "항상 허용"한 행동 → 터미널에서 등급이 낮아도 통과(다시 묻지 않는다).
 *  · 데스크탑에서 영구 거부한 행동  → 터미널에서 full 권한이어도 거부.
 * 규칙이 없을 때만 아래의 기존 등급 게이트가 답한다(기존 동작 그대로).
 *
 * ctx.db 가 없으면(단위 테스트·DB 없는 호출) 규칙을 못 읽으므로 종전 등급 게이트만 돈다.
 */
function toolAskFor(tool, args) {
  const kind = tool.minPerm === "read" ? "read" : tool.name === "bash" ? "execute" : "edit";
  const detail = tool.name === "bash"
    ? String((args && args.command) || "").trim()
    : String((args && args.path) || "").trim();
  return { tool: tool.name, kind, detail: detail || undefined, mutating: kind !== "read" };
}

// 툴 1개 실행 → { ok, content }. 권한 부족/에러는 ok:false 문자열로.
function runTool(name, args, ctx) {
  const tool = BY_NAME[name];
  if (!tool) return { ok: false, content: `unknown tool: ${name}` };
  const ask = toolAskFor(tool, args);
  let ruled = null;
  if (ctx && ctx.db) {
    try {
      const permissions = require("./agentlas-permissions.cjs");
      const verdict = permissions.decideCapability(ctx.db, {
        ...ask,
        permission: ctx.permission,
        agentId: ctx.agentId,
        chatId: ctx.chatId,
      });
      ruled = verdict.ruled;
      if (ruled === "deny") {
        return {
          ok: false,
          content:
            `capability denied: '${name}'${ask.detail ? ` (${ask.detail})` : ""} is permanently denied by a shared ` +
            "capability rule (Desktop/Terminal share capability_grants). Remove that rule to allow it.",
        };
      }
    } catch {
      // 규칙을 못 읽는 것이 허용이 되면 안 되고, 실행을 죽여서도 안 된다 — 기존 등급 게이트로 간다.
      ruled = null;
    }
  }
  const rank = PERM_RANK[ctx.permission] ?? 0;
  if (ruled !== "allow" && (PERM_RANK[tool.minPerm] ?? 0) > rank) {
    return {
      ok: false,
      content: `permission denied: '${name}' requires '${tool.minPerm}' but current is '${ctx.permission}'. Ask the user to run /permission ${tool.minPerm}.`,
    };
  }
  try {
    return { ok: true, content: String(tool.run(args || {}, ctx)) };
  } catch (e) {
    return { ok: false, content: `${name} error: ${e && e.message ? e.message : String(e)}` };
  }
}

// ── provider별 tool 선언 포맷 ─────────────────────────────
function anthropicTools(permission) {
  return allowedTools(permission).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}
function openaiTools(permission) {
  return allowedTools(permission).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

module.exports = { TOOLS, BY_NAME, allowedTools, runTool, anthropicTools, openaiTools, PERM_RANK, toolAskFor };
