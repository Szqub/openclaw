#!/usr/bin/env node
// Secretless runtime proof for the frozen Claude transcript-root candidate.
//
// The Gateway, CLI RPC, native Claude Code process, native transcripts, and
// SQLite state are real. Only Anthropic's HTTP model service is synthetic and
// loopback-bound. The script deliberately emits a summary only; detailed
// process output stays in an uncollected temporary directory.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const candidateArg = process.argv.indexOf("--candidate");
const EXPECTED_HEAD =
  candidateArg < 0 ? "d165b4954dcc0b5ad0fb3cf999a6ce28753420ea" : process.argv[candidateArg + 1];
if (!/^[a-f0-9]{40}$/.test(EXPECTED_HEAD)) throw new Error("invalid candidate SHA");
const CLAUDE_VERSION = "2.1.269";
const GATEWAY_TOKEN = "pr145895-proof-token";
const MODEL = "claude-cli/claude-sonnet-4-6";
const RPC_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 240_000;
const READY_TIMEOUT_MS = 90_000;
const SHUTDOWN_TIMEOUT_MS = 12_000;
const DUMMY_API_KEY = "sk-ant-pr145895-proof-dummy";
const MARKER_RE = /(?:SEED|PROOF-REPLY|NATIVE-ONLY|FORK)-[A-Za-z0-9-]+|DECOY-WRONG-ROOT-MARKER/g;

const outputDir = resolveOutputDir(process.argv.slice(2));
const scenarioArg = process.argv.indexOf("--scenario");
const requestedScenario = scenarioArg < 0 ? "all" : process.argv[scenarioArg + 1];
const forkEntryArg = process.argv.indexOf("--fork-entry");
const forkEntry = forkEntryArg < 0 ? "chat" : process.argv[forkEntryArg + 1];
if (!["chat", "agent"].includes(forkEntry)) throw new Error("unsupported fork entry point");
if (!["all", "absolute", "native-fork", "profile-switch"].includes(requestedScenario))
  throw new Error("unsupported proof scenario");
const candidateRoot = path.resolve(process.cwd());
const tempRoot = path.join(
  process.env.RUNNER_TEMP?.trim() || "/tmp",
  `openclaw-pr145895-runtime-${process.pid}-${Date.now()}`,
);
const summary = {
  schemaVersion: 1,
  candidate: { expectedHead: EXPECTED_HEAD, cwd: candidateRoot },
  mockModel: { kind: "synthetic-loopback-anthropic-messages", realProvider: false },
  claude: { expectedVersion: CLAUDE_VERSION },
  phases: [],
  unsupported: [],
  cleanup: { gatewayChildren: [], ownedClaudeProcessesBefore: [], ownedClaudeProcessesAfter: [] },
  status: "running",
  requestedScenario,
  forkEntry,
};

let mockServer;
let currentGateway;
let fatalFailure = false;

function resolveOutputDir(argv) {
  const index = argv.indexOf("--output");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || value.startsWith("-")) {
    throw new Error("usage: node scripts/pr145895-proof/runtime.mjs --output <directory>");
  }
  return path.resolve(value);
}

function safeText(value) {
  return String(value ?? "")
    .replaceAll(DUMMY_API_KEY, "<dummy-api-key>")
    .replaceAll(GATEWAY_TOKEN, "<gateway-token>")
    .replaceAll(tempRoot, "<proof-temp>")
    .replaceAll(
      /("[^"\n]*(?:token|secret|password|authorization|apiKey)[^"\n]*"\s*:\s*")[^"]*"/giu,
      '$1<redacted>"',
    )
    .replaceAll(/sk-ant-[A-Za-z0-9._-]+/gu, "<redacted-api-key>")
    .replaceAll(/Bearer\s+\S+/giu, "Bearer <redacted>");
}

function phase(name, status, details = {}) {
  summary.phases.push({ name, status, ...details });
  process.stdout.write(`[pr145895-proof] ${name}: ${status}\n`);
}

function unsupported(name, reason, details = {}) {
  summary.unsupported.push({ name, reason, ...details });
  phase(name, "unsupported", { reason, ...details });
}

function fail(name, error, details = {}) {
  fatalFailure = true;
  const reason = safeText(error instanceof Error ? error.message : error);
  phase(name, "failed", { reason, ...details });
}

function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? TURN_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? candidateRoot,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      setTimeout(() => {
        if (!settled) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }, 2_000).unref?.();
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, ...result });
    };
    child.once("error", (error) => finish({ code: null, signal: null, error }));
    child.once("close", (code, signal) => finish({ code, signal, error: undefined }));
  });
}

function uniqueMarkers(text) {
  return [...new Set(String(text ?? "").match(MARKER_RE) ?? [])];
}

function extractJson(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    // The CLI can print a short diagnostic line before its JSON envelope.
  }
  const lines = trimmed.split(/\r?\n/u);
  for (let start = lines.length - 1; start >= 0; start -= 1) {
    let candidate = "";
    for (let end = start; end < lines.length; end += 1) {
      candidate = candidate ? `${candidate}\n${lines[end]}` : lines[end];
      try {
        return JSON.parse(candidate);
      } catch {
        // Keep extending the candidate until a complete JSON value is found.
      }
    }
  }
  return undefined;
}

function unwrapRpc(raw, method) {
  if (!raw || typeof raw !== "object") {
    throw new Error(`${method} returned no JSON envelope`);
  }
  if (raw.ok === false) {
    throw new Error(`${method} RPC failed (${safeText(raw.error?.message ?? "unknown error")})`);
  }
  return raw.payload ?? raw.result ?? raw.data ?? raw;
}

function commandPath() {
  for (const entry of ["dist/index.mjs", "dist/index.js"]) {
    const candidate = path.join(candidateRoot, entry);
    if (existsSync(candidate)) {
      return path.join(candidateRoot, "openclaw.mjs");
    }
  }
  throw new Error("missing built candidate dist/index.(m)js; run pnpm build first");
}

function resolveClaude() {
  const pathValue = process.env.PATH ?? "";
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const name of process.platform === "win32"
      ? ["claude.exe", "claude.cmd", "claude"]
      : ["claude"]) {
      const candidate = path.join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error("official Claude Code executable `claude` is missing from PATH");
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("could not reserve a loopback port");
  return port;
}

async function readBody(req, maxBytes = 32 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("synthetic model request exceeded body limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function anthropicEvents(sequence, reply, model) {
  return [
    {
      type: "message_start",
      message: {
        id: `msg-pr145895-${sequence}`,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 64, output_tokens: 1 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 24 },
    },
    { type: "message_stop" },
  ];
}

async function startMockModel() {
  const records = [];
  let sequence = 0;
  const server = createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (
      req.method === "GET" &&
      (requestUrl.pathname === "/health" || requestUrl.pathname === "/healthz")
    ) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, sequence }));
      return;
    }
    if (req.method === "GET" && requestUrl.pathname === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "claude-sonnet-4-6", type: "model" }] }));
      return;
    }
    if (req.method !== "POST" || !requestUrl.pathname.startsWith("/v1/messages")) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: safeText(error) },
        }),
      );
      return;
    }
    sequence += 1;
    if (requestUrl.pathname.endsWith("/count_tokens")) {
      records.push({
        sequence,
        kind: "count_tokens",
        model: typeof payload.model === "string" ? payload.model : undefined,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 64 }));
      return;
    }
    const serialized = JSON.stringify(payload);
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const markersByRole = {};
    for (const message of messages) {
      const text =
        typeof message?.content === "string"
          ? message.content
          : Array.isArray(message?.content)
            ? message.content
                .filter((block) => block?.type === "text")
                .map((block) => block.text)
                .join("\n")
            : "";
      const role = typeof message?.role === "string" ? message.role : "unknown";
      const markers = uniqueMarkers(text);
      if (markers.length > 0)
        markersByRole[role] = [...new Set([...(markersByRole[role] ?? []), ...markers])];
    }
    const reply = `PROOF-REPLY-${sequence}`;
    records.push({
      sequence,
      kind: "messages",
      reply,
      model: typeof payload.model === "string" ? payload.model : undefined,
      stream: payload.stream === true,
      tools: Array.isArray(payload.tools) ? payload.tools.length : 0,
      messageCount: messages.length,
      markers: uniqueMarkers(serialized),
      markersByRole,
    });
    const events = anthropicEvents(sequence, reply, payload.model ?? "claude-sonnet-4-6");
    if (payload.stream === true) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.end(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      );
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: `msg-pr145895-${sequence}`,
        type: "message",
        role: "assistant",
        model: payload.model ?? "claude-sonnet-4-6",
        content: [{ type: "text", text: reply }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 64, output_tokens: 24 },
      }),
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("mock model did not bind a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    records,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function scenarioRoot(kind, runDir, workspace) {
  if (kind === "default") return path.join(runDir, "home", ".claude");
  if (kind === "absolute") return path.join(runDir, "claude-absolute");
  return path.resolve(workspace, "relative-claude");
}

function scenarioEnv(scenario) {
  const env = {
    ...process.env,
    CI: "1",
    HOME: scenario.home,
    OPENCLAW_HOME: scenario.home,
    OPENCLAW_STATE_DIR: scenario.state,
    OPENCLAW_CONFIG_PATH: scenario.config,
    OPENCLAW_NO_ONBOARD: "1",
    OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN,
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
    PATH: `${path.dirname(summary.claude.executable)}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  if (scenario.kind !== "default") env.CLAUDE_CONFIG_DIR = scenario.configDirValue;
  else delete env.CLAUDE_CONFIG_DIR;
  return env;
}

function configFor(scenario) {
  return {
    gateway: {
      mode: "local",
      port: scenario.gatewayPort,
      auth: { mode: "token", token: GATEWAY_TOKEN },
    },
    plugins: {
      entries: { anthropic: { enabled: true, config: { sessionCatalog: { enabled: true } } } },
    },
    agents: {
      defaults: {
        workspace: scenario.workspace,
        cwd: scenario.workspace,
        model: MODEL,
        models: {
          "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
        },
        skipBootstrap: true,
      },
    },
    logging: { level: "info", consoleLevel: "warn" },
  };
}

async function prepareScenario(kind, runDir, mockBaseUrl, label = kind) {
  const home = path.join(runDir, "home");
  const workspace = path.join(runDir, "workspace");
  const state = path.join(runDir, "state");
  const config = path.join(state, "openclaw.json");
  const selectedRoot = scenarioRoot(kind, runDir, workspace);
  const configDirValue =
    kind === "absolute" ? selectedRoot : kind === "relative" ? "relative-claude" : undefined;
  const gatewayPort = await freePort();
  await mkdir(selectedRoot, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(state, { recursive: true });
  await writeFile(
    path.join(selectedRoot, "settings.json"),
    JSON.stringify(
      {
        env: { ANTHROPIC_BASE_URL: mockBaseUrl, ANTHROPIC_API_KEY: DUMMY_API_KEY },
      },
      null,
      2,
    ),
  );
  if (kind !== "default") {
    const decoyRoot = path.join(home, ".claude");
    const decoyProject = path.join(decoyRoot, "projects", "decoy-project");
    await mkdir(decoyProject, { recursive: true });
    await writeFile(
      path.join(decoyRoot, "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:1" } }, null, 2),
    );
    await writeFile(
      path.join(decoyProject, "decoy-session.jsonl"),
      `${JSON.stringify({
        type: "user",
        sessionId: "decoy-session",
        message: { role: "user", content: "DECOY-WRONG-ROOT-MARKER" },
      })}\n`,
    );
  }
  await writeFile(config, `${JSON.stringify(configFor({ gatewayPort, workspace }), null, 2)}\n`);
  return {
    label,
    kind,
    runDir,
    home,
    workspace,
    state,
    config,
    selectedRoot,
    configDirValue,
    gatewayPort,
    sessionKey: `agent:main:pr145895-${label}`,
    seed: `SEED-${label}-${createHash("sha256").update(`${label}-${Date.now()}-${randomUUID()}`).digest("hex").slice(0, 12)}`,
    env: undefined,
  };
}

async function rpc(scenario, method, params = {}, timeoutMs = RPC_TIMEOUT_MS) {
  const env = scenarioEnv(scenario);
  const result = await run(
    process.execPath,
    [
      summary.cliEntry,
      "gateway",
      "call",
      method,
      "--port",
      String(scenario.gatewayPort),
      "--token",
      GATEWAY_TOKEN,
      "--timeout",
      String(timeoutMs),
      "--json",
      "--params",
      JSON.stringify(params),
    ],
    { cwd: candidateRoot, env, timeoutMs: timeoutMs + 15_000 },
  );
  const parsed = extractJson(result.stdout);
  if (result.code !== 0 || !parsed) {
    throw new Error(
      `${method} command failed (exit=${result.code ?? "null"}): ${safeText(`${result.stderr}\n${result.stdout}`.slice(-2000))}`,
    );
  }
  return unwrapRpc(parsed, method);
}

async function waitForGateway(scenario) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await rpc(scenario, "health", {}, 5_000);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Gateway did not become ready (${safeText(lastError)})`);
}

async function startGateway(scenario, tag) {
  const logPath = path.join(scenario.runDir, `gateway-${tag}.log`);
  const fd = openSync(logPath, "a");
  const child = spawn(
    process.execPath,
    [
      summary.cliEntry,
      "gateway",
      "run",
      "--bind",
      "loopback",
      "--port",
      String(scenario.gatewayPort),
      "--auth",
      "token",
      "--token",
      GATEWAY_TOKEN,
    ],
    {
      cwd: candidateRoot,
      env: scenarioEnv(scenario),
      detached: true,
      stdio: ["ignore", fd, fd],
    },
  );
  closeSync(fd);
  currentGateway = { child, scenario, tag, logPath };
  summary.cleanup.gatewayChildren.push({ tag, pid: child.pid });
  await waitForGateway(scenario);
}

async function stopGateway() {
  const owned = currentGateway;
  if (!owned?.child?.pid) {
    currentGateway = undefined;
    return;
  }
  const pid = owned.child.pid;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      owned.child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (owned.child.exitCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (owned.child.exitCode === null) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        owned.child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
  currentGateway = undefined;
}

async function sendTurn(scenario, marker, message) {
  const started = await rpc(
    scenario,
    "chat.send",
    {
      sessionKey: scenario.sessionKey,
      message: `${message}\nProof marker: ${marker}`,
      deliver: false,
      idempotencyKey: randomUUID(),
    },
    30_000,
  );
  if (started?.status !== "started" || typeof started.runId !== "string") {
    throw new Error("chat.send did not return a started run");
  }
  const terminal = await rpc(
    scenario,
    "agent.wait",
    { runId: started.runId, timeoutMs: TURN_TIMEOUT_MS },
    TURN_TIMEOUT_MS + 15_000,
  );
  if (terminal?.status !== "ok")
    throw new Error(
      `agent.wait returned ${String(terminal?.status ?? "unknown")}: ${safeText(JSON.stringify(terminal).slice(-1500))}`,
    );
  return { runId: started.runId };
}

async function scanTranscripts(root) {
  const projects = path.join(root, "projects");
  if (!existsSync(projects)) return [];
  const result = [];
  for (const project of await readdir(projects)) {
    const directory = path.join(projects, project);
    const info = await stat(directory).catch(() => undefined);
    if (!info?.isDirectory()) continue;
    for (const file of await readdir(directory)) {
      if (file.endsWith(".jsonl")) result.push(path.join(directory, file));
    }
  }
  return result.sort();
}

async function transcriptFacts(root) {
  const files = await scanTranscripts(root);
  const text = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
  const sessionIds = new Set();
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const id = row.sessionId ?? row.session_id;
      if (typeof id === "string" && id) sessionIds.add(id);
    } catch {
      // Native files can contain process-owned non-JSON lines; marker checks remain bounded.
    }
  }
  return { files, sessionIds: [...sessionIds], markers: uniqueMarkers(text), text };
}

function mainRequests(records) {
  return records.filter((record) => record.kind === "messages" && record.tools > 0);
}

function sameSessionIds(left, right) {
  return left.length === right.length && left.every((sessionId) => right.includes(sessionId));
}

async function nativeResume(scenario, sessionId, marker) {
  const env = scenarioEnv(scenario);
  const result = await run(
    summary.claude.executable,
    [
      "-p",
      "--output-format",
      "text",
      "--verbose",
      "--setting-sources",
      "user",
      "--resume",
      sessionId,
      `Write down this marker exactly: ${marker}. Reply briefly.`,
    ],
    { cwd: scenario.workspace, env, timeoutMs: TURN_TIMEOUT_MS },
  );
  if (result.code !== 0)
    throw new Error(
      `direct native resume failed (exit=${result.code ?? "null"}): ${safeText(result.stderr.slice(-1500))}`,
    );
  const reply = result.stdout.match(/PROOF-REPLY-[A-Za-z0-9-]+/)?.[0];
  if (!reply) throw new Error("direct native resume returned no synthetic reply marker");
  return { reply };
}

async function listClaudeCatalog(scenario, sourceSessionId) {
  const deadline = Date.now() + 30_000;
  let last;
  while (Date.now() < deadline) {
    try {
      const result = await rpc(
        scenario,
        "sessions.catalog.list",
        {
          catalogId: "claude",
          agentId: "main",
          hostIds: ["gateway:local"],
          limitPerHost: 100,
        },
        15_000,
      );
      const catalog = result?.catalogs?.find((entry) => entry.id === "claude");
      const host = catalog?.hosts?.find((entry) => entry.hostId === "gateway:local");
      const row = host?.sessions?.find(
        (entry) => entry.threadId === sourceSessionId && entry.canContinue,
      );
      if (row) return row;
      last = new Error("source native session not visible in claude catalog");
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw last ?? new Error("claude catalog list timed out");
}

async function runStandaloneNativeFork(mock) {
  const scenario = await prepareScenario(
    "absolute",
    path.join(tempRoot, "native-fork"),
    mock.baseUrl,
    "native-fork",
  );
  const sourceSessionId = randomUUID();
  const sourceMarker = `SEED-native-fork-${randomUUID()}`;
  const forkMarker = `FORK-${randomUUID()}`;
  const checks = [];
  try {
    // Bound OpenClaw sessions are linked, not adopted. Seed an independent native session.
    const created = await run(
      summary.claude.executable,
      [
        "-p",
        "--output-format",
        "text",
        "--setting-sources",
        "user",
        "--model",
        "claude-sonnet-4-6",
        "--session-id",
        sourceSessionId,
        `Remember this marker: ${sourceMarker}. Acknowledge briefly.`,
      ],
      { cwd: scenario.workspace, env: scenarioEnv(scenario), timeoutMs: TURN_TIMEOUT_MS },
    );
    if (created.code !== 0 || !created.stdout.includes("PROOF-REPLY-")) {
      throw new Error(`native-only seed failed: ${safeText(created.stderr.slice(-1500))}`);
    }
    const seeded = await transcriptFacts(scenario.selectedRoot);
    if (!seeded.sessionIds.includes(sourceSessionId) || !seeded.markers.includes(sourceMarker)) {
      throw new Error("native-only seed transcript missing");
    }
    checks.push({ name: "unbound-native-source", status: "passed" });
    await startGateway(scenario, "native-fork");
    const row = await listClaudeCatalog(scenario, sourceSessionId);
    const adopted = await rpc(scenario, "sessions.catalog.continue", {
      catalogId: "claude",
      hostId: "gateway:local",
      threadId: row.threadId,
      agentId: "main",
    });
    if (typeof adopted?.sessionKey !== "string")
      throw new Error("native adoption returned no session key");
    checks.push({ name: "catalog-adoption", status: "passed" });
    if (forkEntry === "agent") {
      const turn = await run(
        process.execPath,
        [
          summary.cliEntry,
          "agent",
          "--session-key",
          adopted.sessionKey,
          "--message",
          `Continue this adopted native session. Proof marker: ${forkMarker}`,
          "--json",
          "--timeout",
          "240",
        ],
        { env: scenarioEnv(scenario), timeoutMs: TURN_TIMEOUT_MS + 30_000 },
      );
      if (turn.code !== 0 || !turn.stdout.includes("PROOF-REPLY-")) {
        throw new Error(
          `agent command failed (exit=${turn.code}): ${safeText(`${turn.stderr}\n${turn.stdout}`.slice(-2000))}`,
        );
      }
    } else {
      await sendTurn(
        { ...scenario, sessionKey: adopted.sessionKey },
        forkMarker,
        "Continue this adopted native session and acknowledge the new marker.",
      );
    }
    await stopGateway();
    const inspected = await run(
      process.execPath,
      [
        "--import",
        path.join(candidateRoot, "scripts/tsx.mjs"),
        fileURLToPath(new URL("./binding-inspect.mts", import.meta.url)),
        adopted.sessionKey,
      ],
      { env: scenarioEnv(scenario), timeoutMs: 120_000 },
    );
    if (inspected.code !== 0)
      throw new Error(`canonical binding read failed: ${safeText(inspected.stderr.slice(-2000))}`);
    const observed = extractJson(inspected.stdout);
    const binding = observed?.binding;
    const nativeFacts = await transcriptFacts(scenario.selectedRoot);
    checks.push({
      name: "persisted-binding-observation",
      status: "observed",
      sourceSessionId,
      observed,
      nativeSessionIds: nativeFacts.sessionIds,
    });
    if (!binding?.sessionId || binding.sessionId === sourceSessionId)
      throw new Error("fork successor was not persisted");
    if (binding.transcriptRoot !== path.join(scenario.selectedRoot, "projects"))
      throw new Error("fork successor lost the selected transcript root");
    const files = await scanTranscripts(scenario.selectedRoot);
    const successorFile = files.find(
      (file) => path.basename(file) === `${binding.sessionId}.jsonl`,
    );
    if (!successorFile || !(await readFile(successorFile, "utf8")).includes(forkMarker))
      throw new Error("successor native transcript lacks the fork turn");
    checks.push({
      name: "native-fork-and-persisted-root",
      status: "passed",
      sourceSessionId,
      successorSessionId: binding.sessionId,
      persistedRootMatches: true,
    });
    phase("standalone-native-fork", "passed", { checks });
  } catch (error) {
    fail("standalone-native-fork", error, { checks });
  } finally {
    await stopGateway();
  }
}

async function runAbsoluteFull(scenario, mock) {
  const step = { name: "absolute", status: "running", checks: [] };
  try {
    await startGateway(scenario, "absolute-a");
    await sendTurn(scenario, scenario.seed, "Remember this proof code and acknowledge it briefly.");
    const firstReply = mainRequests(mock.records).at(-1)?.reply;
    if (!firstReply) throw new Error("first real Gateway turn had no synthetic reply record");
    step.checks.push({ name: "first-turn", status: "passed" });
    await sendTurn(
      scenario,
      `${scenario.seed}-TWO`,
      "Repeat the proof code from the previous turn, then say DONE.",
    );
    const second = mainRequests(mock.records).at(-1);
    if (!second?.markers?.includes(scenario.seed) || !second.markers.includes(firstReply)) {
      throw new Error("warm second turn did not carry native context markers");
    }
    const beforeRestartFacts = await transcriptFacts(scenario.selectedRoot);
    const sourceSessionId = beforeRestartFacts.sessionIds.at(-1);
    if (!sourceSessionId)
      throw new Error("could not identify native Claude session id before restart");
    step.checks.push({ name: "warm-two-turn-context", status: "passed" });
    await stopGateway();
    await startGateway(scenario, "absolute-b");
    await sendTurn(
      scenario,
      `${scenario.seed}-THREE`,
      "Repeat the proof code once more after Gateway restart.",
    );
    const afterRestart = mainRequests(mock.records).at(-1);
    if (
      !afterRestart?.markers?.includes(scenario.seed) ||
      !afterRestart.markers.includes(`${scenario.seed}-THREE`) ||
      !afterRestart.markers.includes(firstReply)
    ) {
      throw new Error("post-restart turn did not resume native context");
    }
    const afterRestartFacts = await transcriptFacts(scenario.selectedRoot);
    if (!afterRestartFacts.markers.includes(`${scenario.seed}-THREE`)) {
      throw new Error("post-restart native transcript lacks the new turn marker");
    }
    if (!sameSessionIds(beforeRestartFacts.sessionIds, afterRestartFacts.sessionIds)) {
      throw new Error("post-restart turn changed the native session id");
    }
    step.checks.push({ name: "gateway-restart-resume", status: "passed" });

    const historyBeforeNative = await rpc(
      scenario,
      "chat.history",
      { sessionKey: scenario.sessionKey, limit: 100 },
      30_000,
    );
    const historyText = JSON.stringify(historyBeforeNative);
    if (!historyText.includes(scenario.seed)) throw new Error("chat.history omitted Gateway turns");
    step.checks.push({ name: "chat-history-before-native-append", status: "passed" });

    const beforeNative = await transcriptFacts(scenario.selectedRoot);
    if (!sameSessionIds(beforeRestartFacts.sessionIds, beforeNative.sessionIds)) {
      throw new Error("native session id was not stable before direct append");
    }
    await stopGateway();
    const nativeMarker = `NATIVE-ONLY-${createHash("sha256").update(scenario.seed).digest("hex").slice(0, 10)}`;
    const native = await nativeResume(scenario, sourceSessionId, nativeMarker);
    step.checks.push({ name: "direct-native-append", status: "passed", marker: nativeMarker });

    await startGateway(scenario, "absolute-c");
    const historyAfterNative = await rpc(
      scenario,
      "chat.history",
      { sessionKey: scenario.sessionKey, limit: 120 },
      30_000,
    );
    if (!JSON.stringify(historyAfterNative).includes(nativeMarker)) {
      throw new Error("chat.history did not import the direct native append");
    }
    step.checks.push({
      name: "chat-history-native-import",
      status: "passed",
      marker: nativeMarker,
    });

    step.status = "passed";
  } catch (error) {
    step.status = "failed";
    step.reason = safeText(error instanceof Error ? error.message : error);
    fatalFailure = true;
  } finally {
    await stopGateway();
  }
  phase(step.name, step.status, {
    checks: step.checks,
    ...(step.reason ? { reason: step.reason } : {}),
  });
  return step;
}

async function runRootSmoke(kind, mock, runDir) {
  const scenarioRun = path.join(runDir, kind);
  const scenario = await prepareScenario(kind, scenarioRun, mock.baseUrl);
  const step = { name: kind, status: "running", checks: [] };
  try {
    await startGateway(scenario, `${kind}-a`);
    await sendTurn(scenario, scenario.seed, `Remember the ${kind} root proof code.`);
    const firstReply = mainRequests(mock.records).at(-1)?.reply;
    await sendTurn(scenario, `${scenario.seed}-TWO`, `Repeat the ${kind} root proof code.`);
    const second = mainRequests(mock.records).at(-1);
    if (
      !firstReply ||
      !second?.markers?.includes(scenario.seed) ||
      !second.markers.includes(firstReply)
    ) {
      throw new Error(`${kind} root warm resume did not carry markers`);
    }
    step.checks.push({ name: "two-turn-resume", status: "passed" });
    const beforeRestartFacts = await transcriptFacts(scenario.selectedRoot);
    const sourceSessionId = beforeRestartFacts.sessionIds.at(-1);
    if (!sourceSessionId)
      throw new Error(`${kind} root has no stable native session id before restart`);
    await stopGateway();
    await startGateway(scenario, `${kind}-b`);
    await sendTurn(scenario, `${scenario.seed}-THREE`, `${kind} root restart resume.`);
    const afterRestartRequest = mainRequests(mock.records).at(-1);
    if (
      !afterRestartRequest?.markers?.includes(scenario.seed) ||
      !afterRestartRequest.markers.includes(`${scenario.seed}-THREE`) ||
      !afterRestartRequest.markers.includes(firstReply)
    ) {
      throw new Error(`${kind} root restart request did not carry the native context markers`);
    }
    const facts = await transcriptFacts(scenario.selectedRoot);
    const expectedRoot = path.resolve(scenario.selectedRoot);
    if (
      !facts.files.length ||
      !facts.markers.includes(scenario.seed) ||
      !facts.markers.includes(`${scenario.seed}-THREE`)
    )
      throw new Error(`${kind} root has no native transcript marker`);
    if (!sameSessionIds(beforeRestartFacts.sessionIds, facts.sessionIds))
      throw new Error(`${kind} root changed native session id after restart`);
    const decoyFiles =
      kind === "default" ? [] : await scanTranscripts(path.join(scenario.home, ".claude"));
    const expectedDecoyFiles = kind === "default" ? 0 : 1;
    if (decoyFiles.length !== expectedDecoyFiles) {
      throw new Error(
        `${kind} root changed the decoy default root (expected ${expectedDecoyFiles} transcript file(s), saw ${decoyFiles.length})`,
      );
    }
    if (mock.records.some((record) => (record.markers ?? []).includes("DECOY-WRONG-ROOT-MARKER"))) {
      throw new Error(`${kind} root leaked decoy transcript content to the model request`);
    }
    step.checks.push({
      name: "restart-and-root-selection",
      status: "passed",
      rootKind: kind,
      resolvedRoot: expectedRoot,
      transcriptCount: facts.files.length,
    });
    step.status = "passed";
  } catch (error) {
    step.status = "failed";
    step.reason = safeText(error instanceof Error ? error.message : error);
    fatalFailure = true;
  } finally {
    await stopGateway();
  }
  phase(step.name, step.status, {
    checks: step.checks,
    ...(step.reason ? { reason: step.reason } : {}),
  });
  return step;
}

async function runProfileSwitch(mock, runDir) {
  const switchDir = path.join(runDir, "profile-switch");
  const scenario = await prepareScenario("absolute", switchDir, mock.baseUrl, "profile-switch");
  const switchedRoot = path.join(switchDir, "claude-switched");
  await mkdir(switchedRoot, { recursive: true });
  await writeFile(
    path.join(switchedRoot, "settings.json"),
    JSON.stringify(
      { env: { ANTHROPIC_BASE_URL: mock.baseUrl, ANTHROPIC_API_KEY: DUMMY_API_KEY } },
      null,
      2,
    ),
  );
  const step = { name: "profile-switch-history-authority", status: "running", checks: [] };
  try {
    await startGateway(scenario, "switch-a");
    await sendTurn(
      scenario,
      scenario.seed,
      "Establish a native transcript before switching roots.",
    );
    await stopGateway();
    const before = await transcriptFacts(scenario.selectedRoot);
    const nativeSessionId = before.sessionIds.at(-1);
    if (!nativeSessionId) throw new Error("missing established native session");
    const nativeMarker = `NATIVE-ONLY-profile-${randomUUID()}`;
    await nativeResume(scenario, nativeSessionId, nativeMarker);
    await startGateway(scenario, "same-profile-restart");
    const allowed = await rpc(scenario, "chat.history", {
      sessionKey: scenario.sessionKey,
      limit: 100,
    });
    if (!JSON.stringify(allowed).includes(nativeMarker))
      throw new Error("same-profile restart did not import the native-only marker");
    step.checks.push({ name: "same-profile-restart-native-import", status: "passed" });
    await stopGateway();
    scenario.configDirValue = switchedRoot;
    scenario.env = undefined;
    await startGateway(scenario, "switch-b");
    const inspected = await run(
      process.execPath,
      [
        "--import",
        path.join(candidateRoot, "scripts/tsx.mjs"),
        fileURLToPath(new URL("./binding-inspect.mts", import.meta.url)),
        scenario.sessionKey,
      ],
      { env: scenarioEnv(scenario), timeoutMs: 120_000 },
    );
    const retained = extractJson(inspected.stdout)?.binding;
    if (
      inspected.code !== 0 ||
      retained?.sessionId !== nativeSessionId ||
      retained?.transcriptRoot !== path.join(scenario.selectedRoot, "projects")
    )
      throw new Error("profile-switch fixture lost the persisted old binding");
    step.checks.push({ name: "old-binding-still-retained", status: "passed" });
    const rejected = await rpc(scenario, "chat.history", {
      sessionKey: scenario.sessionKey,
      limit: 100,
    });
    if (JSON.stringify(rejected).includes(nativeMarker))
      throw new Error("changed profile imported the old native-only marker");
    if (!JSON.stringify(rejected).includes(scenario.seed))
      throw new Error("profile rejection discarded canonical local history");
    step.checks.push({ name: "changed-profile-rejects-native-only-history", status: "passed" });
    let outcome = "started";
    try {
      await sendTurn(
        scenario,
        `${scenario.seed}-SWITCHED`,
        "Characterize the configured Claude profile switch.",
      );
    } catch (error) {
      outcome = "rejected";
      step.reason = safeText(error instanceof Error ? error.message : error);
    }
    const switchedFacts = await transcriptFacts(switchedRoot);
    if (outcome !== "started" || switchedFacts.files.length === 0)
      throw new Error("new profile did not create its own native transcript");
    if (switchedFacts.sessionIds.includes(nativeSessionId))
      throw new Error("new profile reused the previous native session");
    step.checks.push({ name: "new-profile-turn-starts-new-native-session", status: "passed" });
    step.status = "passed";
    step.outcome = outcome;
    step.switchedRoot = path.resolve(switchedRoot);
    step.switchedTranscriptCount = switchedFacts.files.length;
  } catch (error) {
    step.status = "failed";
    step.reason = safeText(error instanceof Error ? error.message : error);
    fatalFailure = true;
  } finally {
    await stopGateway();
  }
  phase(step.name, step.status, {
    checks: step.checks,
    outcome: step.outcome,
    switchedTranscriptCount: step.switchedTranscriptCount,
    ...(step.reason ? { reason: step.reason } : {}),
  });
  return step;
}

async function listOwnedClaudeProcesses() {
  const result = await run("ps", ["-eo", "pid=,ppid=,args="], {
    cwd: candidateRoot,
    timeoutMs: 10_000,
  });
  const rows = [];
  for (const line of result.stdout.split(/\r?\n/u)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/u);
    if (!match || !/\bclaude(?:\.exe)?\b/iu.test(match[3])) continue;
    const pid = Number(match[1]);
    let env = "";
    try {
      env = readFileSync(`/proc/${pid}/environ`, "utf8");
    } catch {
      /* non-Linux or exited */
    }
    if (!env.includes(tempRoot)) continue;
    rows.push({
      pid,
      ppid: Number(match[2]),
      executable: path.basename(match[3].split(/\s+/u)[0] ?? "claude"),
    });
  }
  return rows;
}

async function cleanupOwnedClaudeProcesses() {
  const before = await listOwnedClaudeProcesses();
  summary.cleanup.ownedClaudeProcessesBefore = before;
  for (const row of before) {
    try {
      process.kill(row.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const remaining = await listOwnedClaudeProcesses();
  for (const row of remaining) {
    try {
      process.kill(row.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  if (remaining.length > 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
  summary.cleanup.ownedClaudeProcessesAfter = await listOwnedClaudeProcesses();
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  mkdirSync(tempRoot, { recursive: true });
  summary.cliEntry = commandPath();
  summary.candidate.head = (
    await run("git", ["rev-parse", "HEAD"], { cwd: candidateRoot, timeoutMs: 10_000 })
  ).stdout.trim();
  if (summary.candidate.head !== EXPECTED_HEAD)
    throw new Error(`candidate HEAD mismatch (${summary.candidate.head || "unknown"})`);
  summary.claude.executable = resolveClaude();
  const version = await run(summary.claude.executable, ["--version"], {
    cwd: candidateRoot,
    timeoutMs: 30_000,
  });
  summary.claude.version = version.stdout.match(/\d+\.\d+\.\d+/u)?.[0] ?? "unknown";
  summary.claude.versionMatch = summary.claude.version === CLAUDE_VERSION;
  if (!summary.claude.versionMatch)
    unsupported("claude-version", `expected ${CLAUDE_VERSION}, observed ${summary.claude.version}`);

  // The bundled claude-cli descriptor is static. There is no public config key
  // that injects a per-run prepared CLAUDE_CONFIG_DIR override, so A/B prepared
  // env ownership stays an explicit unsupported characterization here.
  unsupported(
    "prepared-backend-root-override",
    "built-in claude-cli has no public per-run env override; the proof uses the documented process CLAUDE_CONFIG_DIR route",
  );

  mockServer = await startMockModel();
  summary.mockModel.loopbackUrl = mockServer.baseUrl.replace(/:\d+$/u, ":<ephemeral-port>");
  phase("mock-model", "passed", { loopback: true });

  if (requestedScenario === "profile-switch") {
    await runProfileSwitch(mockServer, tempRoot);
  } else if (requestedScenario === "native-fork") {
    await runStandaloneNativeFork(mockServer);
  } else {
    const absoluteRun = path.join(tempRoot, "absolute");
    await mkdir(absoluteRun, { recursive: true });
    const absolute = await prepareScenario("absolute", absoluteRun, mockServer.baseUrl);
    await runAbsoluteFull(absolute, mockServer);
  }
  if (requestedScenario === "all") {
    await runRootSmoke("default", mockServer, tempRoot);
    await runRootSmoke("relative", mockServer, tempRoot);
    await runProfileSwitch(mockServer, tempRoot);
    await runStandaloneNativeFork(mockServer);
  }

  summary.mockModel.requestCount = mockServer.records.length;
  summary.mockModel.messageRequestCount = mockServer.records.filter(
    (record) => record.kind === "messages",
  ).length;
  summary.mockModel.observedMarkers = [
    ...new Set(mockServer.records.flatMap((record) => record.markers ?? [])),
  ].sort();
  summary.status = fatalFailure
    ? "failed"
    : summary.unsupported.length > 0
      ? "passed_with_unsupported"
      : "passed";
}

try {
  await main();
} catch (error) {
  fail("runtime-proof", error);
  summary.status = "failed";
} finally {
  await stopGateway();
  await cleanupOwnedClaudeProcesses();
  if (mockServer) await mockServer.close().catch(() => {});
  if (summary.cleanup.ownedClaudeProcessesAfter.length > 0) {
    fatalFailure = true;
    phase("cleanup", "failed", {
      leftoverOwnedClaudeProcesses: summary.cleanup.ownedClaudeProcessesAfter,
    });
    summary.status = "failed";
  } else {
    phase("cleanup", "passed", { leftoverOwnedClaudeProcesses: [] });
  }
  if (summary.status === "running") summary.status = fatalFailure ? "failed" : "passed";
  await writeFile(
    path.join(outputDir, "pr145895-runtime-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  try {
    await rm(tempRoot, { recursive: true, force: true });
  } catch {
    /* evidence summary is already durable */
  }
  process.exitCode = summary.status === "failed" ? 1 : 0;
}
