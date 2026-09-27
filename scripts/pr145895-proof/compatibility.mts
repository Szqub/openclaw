import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const candidateSha = "d165b4954dcc0b5ad0fb3cf999a6ce28753420ea";
const parentSha = "c23b86fc222700517d1e8a6d32784f80668fdde6";
const args = process.argv.slice(2);
const arg = (name: string) => args[args.indexOf(name) + 1];

async function phase() {
  const action = arg("--phase");
  const sourceRoot = path.resolve(arg("--source"));
  const root = path.resolve(arg("--root"));
  const storePath = path.join(root, "agents/main/agent/openclaw-agent.sqlite");
  const originalCwd = path.join(root, "original-workspace");
  const nextCwd = path.join(root, "next-workspace");
  const originalRoot = path.join(root, "original-profile/projects");
  const nextRoot = path.join(root, "next-profile/projects");
  const load = (relative: string) => import(pathToFileURL(path.join(sourceRoot, relative)).href);
  const accessor = await load("src/config/sessions/session-accessor.ts");
  const owner = await load("src/agents/cli-session.ts");
  const agentDb = await load("src/state/openclaw-agent-db.ts");
  const scope = {
    agentId: "main",
    sessionKey: "agent:main:transcript-root-compatibility",
    storePath,
    env: process.env,
  };
  const binding = (cwd: string, transcriptRoot?: string) => ({
    sessionId: "native-compatibility-session",
    cwd,
    ...(transcriptRoot ? { transcriptRoot } : {}),
    cwdHash: "a".repeat(64),
  });
  if (action === "candidate-seed") {
    const entry = { sessionId: "local-compatibility-session", updatedAt: 1000 };
    owner.setCliSessionBinding(entry, "claude-cli", binding(originalCwd, originalRoot));
    accessor.replaceSessionEntrySync(scope, entry);
  } else if (action === "parent-unrelated-write") {
    await accessor.updateSessionEntry(scope, (entry: Record<string, unknown>) => ({
      label: "unrelated metadata update",
      updatedAt: Number(entry.updatedAt) + 1,
    }));
  } else if (
    action === "parent-binding-replacement" ||
    action === "candidate-binding-replacement"
  ) {
    await accessor.updateSessionEntry(scope, (entry: Record<string, unknown>) => {
      owner.applyCliSessionBindingResult(entry, "claude-cli", {
        cliSessionBinding:
          action === "parent-binding-replacement"
            ? binding(originalCwd)
            : binding(nextCwd, nextRoot),
      });
      return {
        cliSessionBindings: entry.cliSessionBindings,
        cliSessionIds: entry.cliSessionIds,
        updatedAt: Number(entry.updatedAt) + 1,
      };
    });
  } else {
    assert.equal(action, "inspect");
  }
  const loaded = accessor.loadSessionEntry(scope);
  const normalized = owner.getCliSessionBinding(loaded, "claude-cli");
  agentDb.closeOpenClawAgentDatabasesForTest();
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
      .get(scope.sessionKey) as { entry_json: string };
    const raw = JSON.parse(row.entry_json).cliSessionBindings["claude-cli"];
    const schemaVersion = Number(db.prepare("PRAGMA user_version").get()?.user_version);
    const schemaMetaVersion = Number(
      db.prepare("SELECT schema_version FROM schema_meta LIMIT 1").get()?.schema_version,
    );
    process.stdout.write(
      `${JSON.stringify({
        action,
        sourceSha: execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        schemaVersion,
        schemaMetaVersion,
        rawHasCwd: typeof raw.cwd === "string",
        rawHasRoot: typeof raw.transcriptRoot === "string",
        normalizedHasCwd: typeof normalized?.cwd === "string",
        normalizedHasRoot: typeof normalized?.transcriptRoot === "string",
        nativeSessionPreserved: normalized?.sessionId === "native-compatibility-session",
        originalRootPreserved: raw.transcriptRoot === originalRoot,
        replacementRootStored: normalized?.transcriptRoot === nextRoot,
      })}\n`,
    );
  } finally {
    db.close();
  }
}

async function main() {
  const outputDir = path.resolve(arg("--output"));
  fs.mkdirSync(outputDir, { recursive: true });
  const candidate = process.cwd();
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    candidateSha,
  );
  // Shared dependency installation is valid only for byte-identical dependency and workspace inputs.
  execFileSync("git", [
    "diff",
    "--exit-code",
    parentSha,
    candidateSha,
    "--",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "package.json",
    "packages",
  ]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-root-compatibility-"));
  const parent = path.join(root, "parent");
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const stateRoot = path.join(root, "state");
  fs.mkdirSync(stateRoot);
  const report: {
    candidate: string;
    parent: string;
    provider: string;
    status: string;
    phases: unknown[];
    limitation?: string;
    error?: string;
  } = {
    candidate: candidateSha,
    parent: parentSha,
    provider: "secretless-github-hosted",
    status: "running",
    phases: [],
  };
  let parentCreated = false;
  try {
    execFileSync("git", ["worktree", "add", "--detach", parent, parentSha], { stdio: "pipe" });
    parentCreated = true;
    fs.symlinkSync(path.join(candidate, "node_modules"), path.join(parent, "node_modules"), "dir");
    let expectedSchema: number | undefined;
    const invoke = (action: string, source: string) => {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          path.join(candidate, "scripts/tsx.mjs"),
          path.resolve(process.argv[1]),
          "--phase",
          action,
          "--source",
          source,
          "--root",
          stateRoot,
        ],
        {
          cwd: source,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            OPENCLAW_STATE_DIR: stateRoot,
            CI: "1",
            NODE_ENV: "test",
          },
          encoding: "utf8",
          timeout: 120_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      if (result.status !== 0) {
        throw new Error(
          `Compatibility phase ${action} failed (exit ${result.status}): ${result.stderr.slice(-4000).replaceAll(root, "<fixture>").replaceAll(candidate, "<candidate>")}`,
        );
      }
      const observed = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
      report.phases.push(observed);
      assert.equal(observed.sourceSha, source === candidate ? candidateSha : parentSha);
      expectedSchema ??= observed.schemaVersion;
      assert.equal(observed.schemaVersion, expectedSchema);
      assert.equal(observed.schemaVersion, 20);
      assert.equal(observed.schemaMetaVersion, 20);
      assert.equal(observed.nativeSessionPreserved, true);
      assert.equal(observed.rawHasCwd, true);
      return observed;
    };
    const seeded = invoke("candidate-seed", candidate);
    assert.equal(seeded.normalizedHasRoot, true);
    const readByParent = invoke("inspect", parent);
    assert.equal(readByParent.schemaVersion, seeded.schemaVersion);
    assert.equal(readByParent.rawHasRoot, true);
    assert.equal(readByParent.normalizedHasRoot, false);
    assert.equal(invoke("parent-unrelated-write", parent).originalRootPreserved, true);
    assert.equal(invoke("parent-binding-replacement", parent).rawHasRoot, false);
    assert.equal(invoke("inspect", candidate).normalizedHasRoot, false);
    assert.equal(invoke("candidate-binding-replacement", candidate).replacementRootStored, true);
    assert.equal(invoke("inspect", candidate).replacementRootStored, true);
    report.status = "passed";
    report.limitation =
      "The exact same-schema older writer preserves the raw root on read and unrelated writes, but drops transcriptRoot when replacing a binding. Candidate reopen does not reconstruct the old root; a candidate binding replacement records the new root. This is not a stable-release schema downgrade proof.";
  } catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(
      path.join(outputDir, "compatibility.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    if (parentCreated) {
      fs.unlinkSync(path.join(parent, "node_modules"));
      execFileSync("git", ["worktree", "remove", parent]);
    }
    fs.rmSync(root, { recursive: true });
  }
  console.log(`Compatibility proof: ${report.status}`);
}

if (args.includes("--phase")) await phase();
else await main();
