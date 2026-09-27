import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const defaultCandidateSha = "d165b4954dcc0b5ad0fb3cf999a6ce28753420ea";
const defaultParentSha = "c23b86fc222700517d1e8a6d32784f80668fdde6";
const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const requiredArg = (name: string): string => {
  const value = arg(name);
  assert(value, `Missing required argument ${name}`);
  return value;
};

type DatabaseSnapshot = {
  raw: Record<string, unknown>;
  schemaVersion: number;
  schemaMetaVersion: number;
};

type SyntheticManifest = {
  version: 1;
  schemaVersion: number;
  sessionKey: string;
  entrySessionId: string;
  bindingSessionId: string;
  cwd: string;
  transcriptRoot: string;
  transcriptCanary: "skipped";
};

const syntheticSessionKey = "agent:main:transcript-root-compatibility";
const syntheticEntrySessionId = "local-compatibility-session";
const syntheticBindingSessionId = "native-compatibility-session";

function parseEntryJson(value: unknown): Record<string, unknown> {
  const json =
    typeof value === "string" ? value : Buffer.from(value as Uint8Array).toString("utf8");
  return JSON.parse(json) as Record<string, unknown>;
}

function readDatabaseSnapshot(storePath: string, sessionKey: string): DatabaseSnapshot {
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
      .get(sessionKey) as { entry_json?: unknown } | undefined;
    assert(row?.entry_json !== undefined, `Synthetic session row is missing: ${sessionKey}`);
    const schemaVersion = Number(db.prepare("PRAGMA user_version").get()?.user_version);
    const schemaMetaVersion = Number(
      db.prepare("SELECT schema_version FROM schema_meta LIMIT 1").get()?.schema_version,
    );
    return {
      raw: parseEntryJson(row.entry_json),
      schemaVersion,
      schemaMetaVersion,
    };
  } finally {
    db.close();
  }
}

function closeSourceHandles(agentDb: Record<string, unknown>): void {
  const close = agentDb.closeOpenClawAgentDatabasesForTest;
  assert(typeof close === "function", "Source does not expose the test database close hook");
  (close as () => void)();
}

function checkpointAndAssertIntegrity(storePath: string): void {
  const db = new DatabaseSync(storePath);
  try {
    const before = db.prepare("PRAGMA integrity_check").get() as {
      integrity_check?: string;
    };
    assert.equal(before.integrity_check, "ok");
    const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
      | { busy?: number }
      | undefined;
    assert.equal(checkpoint?.busy ?? 0, 0);
    const after = db.prepare("PRAGMA integrity_check").get() as {
      integrity_check?: string;
    };
    assert.equal(after.integrity_check, "ok");
  } finally {
    db.close();
  }
}

function copySqliteFixture(
  storePath: string,
  fixtureDir: string,
  manifest: SyntheticManifest,
): void {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  fs.mkdirSync(fixtureDir, { recursive: true });
  checkpointAndAssertIntegrity(storePath);
  fs.copyFileSync(storePath, path.join(fixtureDir, "openclaw-agent.sqlite"));
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${storePath}${suffix}`;
    if (fs.existsSync(sidecar)) {
      fs.copyFileSync(sidecar, path.join(fixtureDir, `openclaw-agent.sqlite${suffix}`));
    }
  }
  fs.writeFileSync(
    path.join(fixtureDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

function loadFixtureManifest(fixtureDir: string): SyntheticManifest {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(fixtureDir, "manifest.json"), "utf8"),
  ) as SyntheticManifest;
  assert.equal(manifest.version, 1);
  assert.equal(manifest.transcriptCanary, "skipped");
  assert.equal(typeof manifest.cwd, "string");
  assert.equal(typeof manifest.transcriptRoot, "string");
  return manifest;
}

function installFixture(fixtureDir: string, storePath: string): void {
  const fixtureDatabase = path.join(fixtureDir, "openclaw-agent.sqlite");
  assert(fs.existsSync(fixtureDatabase), `Fixture database is missing: ${fixtureDatabase}`);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${storePath}${suffix}`, { force: true });
  }
  fs.copyFileSync(fixtureDatabase, storePath);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = path.join(fixtureDir, `openclaw-agent.sqlite${suffix}`);
    if (fs.existsSync(sidecar)) {
      fs.copyFileSync(sidecar, `${storePath}${suffix}`);
    }
  }
}

function bindingFor(
  cwd: string,
  transcriptRoot?: string,
): { sessionId: string; cwd: string; transcriptRoot?: string; cwdHash: string } {
  return {
    sessionId: syntheticBindingSessionId,
    cwd,
    ...(transcriptRoot ? { transcriptRoot } : {}),
    cwdHash: "a".repeat(64),
  };
}

async function phase() {
  const action = requiredArg("--phase");
  const sourceRoot = path.resolve(requiredArg("--source"));
  const root = path.resolve(requiredArg("--root"));
  const schema = Number(requiredArg("--schema"));
  const expectedSourceSha = arg("--expected-source");
  const storePath = path.join(root, "agents/main/agent/openclaw-agent.sqlite");
  const originalCwd = path.join(root, "original-workspace");
  const nextCwd = path.join(root, "next-workspace");
  const originalRoot = path.join(root, "original-profile/projects");
  const nextRoot = path.join(root, "next-profile/projects");
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const load = (relative: string) => import(pathToFileURL(path.join(sourceRoot, relative)).href);
  const accessor = (await load("src/config/sessions/session-accessor.ts")) as Record<
    string,
    unknown
  >;
  const owner = (await load("src/agents/cli-session.ts")) as Record<string, unknown>;
  const agentDb = (await load("src/state/openclaw-agent-db.ts")) as Record<string, unknown>;
  const scope = {
    agentId: "main",
    sessionKey: syntheticSessionKey,
    storePath,
    env: process.env,
  };
  type SyntheticScope = typeof scope;
  const binding = (cwd: string, transcriptRoot?: string) => bindingFor(cwd, transcriptRoot);
  const loadSessionEntry = accessor.loadSessionEntry as (
    scope: SyntheticScope,
  ) => Record<string, unknown> | undefined;
  const replaceSessionEntrySync = accessor.replaceSessionEntrySync as (
    scope: SyntheticScope,
    entry: Record<string, unknown>,
  ) => void;
  const updateSessionEntry = accessor.updateSessionEntry as (
    scope: SyntheticScope,
    update: (entry: Record<string, unknown>) => unknown,
  ) => Promise<unknown>;
  const setCliSessionBinding = owner.setCliSessionBinding as (
    entry: Record<string, unknown>,
    provider: string,
    value: ReturnType<typeof binding>,
  ) => void;
  const applyCliSessionBindingResult = owner.applyCliSessionBindingResult as (
    entry: Record<string, unknown>,
    provider: string,
    meta: { cliSessionBinding: ReturnType<typeof binding> },
  ) => void;
  const getCliSessionBinding = owner.getCliSessionBinding as (
    entry: Record<string, unknown> | undefined,
    provider: string,
  ) => ReturnType<typeof binding> | undefined;
  const close = () => closeSourceHandles(agentDb);
  const sourceSha = execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (expectedSourceSha) {
    assert.equal(sourceSha, expectedSourceSha);
  }

  if (action === "upgrade-fixture") {
    assert.equal(schema, 23, "Fixture upgrade must run against the schema-23 candidate");
    const fixtureDir = path.resolve(requiredArg("--upgrade-fixture"));
    const manifest = loadFixtureManifest(fixtureDir);
    assert.equal(manifest.schemaVersion, 20);
    installFixture(fixtureDir, storePath);
    close();
    const withMaintenanceLease = agentDb.withAgentDatabaseMaintenanceLease as (
      options: { env: NodeJS.ProcessEnv },
      run: (maintenance: unknown) => Promise<unknown>,
    ) => Promise<unknown>;
    const migrate = agentDb.migrateOpenClawAgentDatabaseForMaintenance as (
      options: { agentId: string; pathname: string },
      maintenance: unknown,
    ) => Promise<void>;
    assert.equal(typeof withMaintenanceLease, "function");
    assert.equal(typeof migrate, "function");
    await withMaintenanceLease({ env: process.env }, async (maintenance) => {
      await migrate({ agentId: "main", pathname: storePath }, maintenance);
    });
    const migratedSnapshot = readDatabaseSnapshot(storePath, manifest.sessionKey);
    assert.equal(migratedSnapshot.schemaVersion, 23);
    assert.equal(migratedSnapshot.schemaMetaVersion, 23);
    const migratedEntry = loadSessionEntry(scope);
    const migratedBinding = getCliSessionBinding(migratedEntry, "claude-cli");
    assert(migratedBinding);
    assert.equal(migratedEntry?.sessionId, manifest.entrySessionId);
    assert.equal(migratedBinding.sessionId, manifest.bindingSessionId);
    assert.equal(migratedBinding.cwd, manifest.cwd);
    assert.equal(migratedBinding.transcriptRoot, manifest.transcriptRoot);
    await updateSessionEntry(scope, (entry) => ({
      label: "schema23 upgrade reopen/write",
      updatedAt: Number(entry.updatedAt) + 1,
    }));
    close();
    const reopenedEntry = loadSessionEntry(scope);
    const reopenedBinding = getCliSessionBinding(reopenedEntry, "claude-cli");
    assert(reopenedBinding);
    assert.equal(reopenedEntry?.sessionId, manifest.entrySessionId);
    assert.equal(reopenedBinding.sessionId, manifest.bindingSessionId);
    assert.equal(reopenedBinding.cwd, manifest.cwd);
    assert.equal(reopenedBinding.transcriptRoot, manifest.transcriptRoot);
    close();
    const finalSnapshot = readDatabaseSnapshot(storePath, manifest.sessionKey);
    process.stdout.write(
      `${JSON.stringify({
        action,
        sourceSha,
        schemaVersion: finalSnapshot.schemaVersion,
        schemaMetaVersion: finalSnapshot.schemaMetaVersion,
        migration: { from: manifest.schemaVersion, to: finalSnapshot.schemaVersion },
        nativeSessionPreserved: reopenedBinding.sessionId === manifest.bindingSessionId,
        cwdPreserved: reopenedBinding.cwd === manifest.cwd,
        transcriptRootPreserved: reopenedBinding.transcriptRoot === manifest.transcriptRoot,
        reopenWritePreserved: reopenedEntry?.label === "schema23 upgrade reopen/write",
        transcriptCanary: manifest.transcriptCanary,
      })}\n`,
    );
    return;
  }

  if (action === "candidate-seed") {
    const entry = { sessionId: syntheticEntrySessionId, updatedAt: 1000 };
    setCliSessionBinding(entry, "claude-cli", binding(originalCwd, originalRoot));
    replaceSessionEntrySync(scope, entry);
  } else if (action === "parent-unrelated-write") {
    await updateSessionEntry(scope, (entry) => ({
      label: "unrelated metadata update",
      updatedAt: Number(entry.updatedAt) + 1,
    }));
  } else if (
    action === "parent-binding-replacement" ||
    action === "candidate-binding-replacement"
  ) {
    await updateSessionEntry(scope, (entry) => {
      applyCliSessionBindingResult(entry, "claude-cli", {
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

  const loaded = loadSessionEntry(scope);
  const normalized = getCliSessionBinding(loaded, "claude-cli");
  close();
  const snapshot = readDatabaseSnapshot(storePath, syntheticSessionKey);
  const raw = snapshot.raw.cliSessionBindings as Record<string, Record<string, unknown>>;
  const rawBinding = raw["claude-cli"];
  assert(rawBinding, "Synthetic CLI binding is missing");
  const exportFixture = arg("--export-fixture");
  if (exportFixture) {
    assert.equal(action, "candidate-seed");
    const manifest: SyntheticManifest = {
      version: 1,
      schemaVersion: snapshot.schemaVersion,
      sessionKey: syntheticSessionKey,
      entrySessionId: syntheticEntrySessionId,
      bindingSessionId: syntheticBindingSessionId,
      cwd: originalCwd,
      transcriptRoot: originalRoot,
      transcriptCanary: "skipped",
    };
    copySqliteFixture(storePath, path.resolve(exportFixture), manifest);
  }
  process.stdout.write(
    `${JSON.stringify({
      action,
      sourceSha,
      schemaVersion: snapshot.schemaVersion,
      schemaMetaVersion: snapshot.schemaMetaVersion,
      rawHasCwd: typeof rawBinding.cwd === "string",
      rawHasRoot: typeof rawBinding.transcriptRoot === "string",
      normalizedHasCwd: typeof normalized?.cwd === "string",
      normalizedHasRoot: typeof normalized?.transcriptRoot === "string",
      nativeSessionPreserved: normalized?.sessionId === syntheticBindingSessionId,
      originalRootPreserved: rawBinding.transcriptRoot === originalRoot,
      replacementRootStored: normalized?.transcriptRoot === nextRoot,
      replacementCwdStored: normalized?.cwd === nextCwd,
      fixtureExported: Boolean(exportFixture),
      transcriptCanary: "skipped",
    })}\n`,
  );
}

async function main() {
  const outputDir = path.resolve(requiredArg("--output"));
  const candidateSha = arg("--candidate") ?? defaultCandidateSha;
  const parentSha = arg("--parent") ?? defaultParentSha;
  const schema = Number(arg("--schema") ?? "20");
  assert(Number.isInteger(schema) && schema > 0, "--schema must be a positive integer");
  const exportFixture = arg("--export-fixture");
  const upgradeFixture = arg("--upgrade-fixture");
  fs.mkdirSync(outputDir, { recursive: true });
  const candidate = process.cwd();
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    candidateSha,
  );
  // Shared dependency installation is valid only for byte-identical dependency and workspace inputs.
  // Keep the links below in place for every same-pair phase after this assertion.
  execFileSync("git", [
    "diff",
    "--exit-code",
    parentSha,
    candidateSha,
    "--",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "package.json",
    ":(glob)**/package.json",
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
    schema: number;
    provider: string;
    status: string;
    phases: unknown[];
    limitation?: string;
    error?: string;
  } = {
    candidate: candidateSha,
    parent: parentSha,
    schema,
    provider: "secretless-github-hosted",
    status: "running",
    phases: [],
  };
  let parentCreated = false;
  const dependencyLinks: string[] = [];
  try {
    execFileSync("git", ["worktree", "add", "--detach", parent, parentSha], { stdio: "pipe" });
    parentCreated = true;
    // pnpm keeps workspace-local dependency links alongside each package, not only at root.
    const manifests = execFileSync(
      "git",
      ["ls-files", "-z", "package.json", ":(glob)**/package.json"],
      { encoding: "utf8" },
    )
      .split("\0")
      .filter(Boolean);
    for (const manifest of manifests) {
      const relative = path.join(path.dirname(manifest), "node_modules");
      const installed = path.join(candidate, relative);
      const linked = path.join(parent, relative);
      if (!fs.existsSync(installed) || !fs.existsSync(path.dirname(linked))) {
        continue;
      }
      fs.symlinkSync(installed, linked, "dir");
      dependencyLinks.push(linked);
    }
    const invoke = (action: string, source: string, extraArgs: readonly string[] = []) => {
      const expectedSourceSha = source === candidate ? candidateSha : parentSha;
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          path.join(source, "scripts/tsx.mjs"),
          path.resolve(process.argv[1]),
          "--phase",
          action,
          "--source",
          source,
          "--root",
          stateRoot,
          "--schema",
          String(schema),
          "--expected-source",
          expectedSourceSha,
          ...extraArgs,
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
          `Compatibility phase ${action} failed (exit ${result.status}): ${result.stderr
            .slice(-4000)
            .replaceAll(root, "<fixture>")
            .replaceAll(candidate, "<candidate>")}`,
        );
      }
      const observed = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
      report.phases.push(observed);
      assert.equal(observed.sourceSha, expectedSourceSha);
      assert.equal(observed.schemaVersion, schema);
      assert.equal(observed.schemaMetaVersion, schema);
      assert.equal(observed.nativeSessionPreserved, true);
      return observed;
    };
    const seeded = invoke(
      "candidate-seed",
      candidate,
      exportFixture ? ["--export-fixture", path.resolve(exportFixture)] : [],
    );
    assert.equal(seeded.normalizedHasRoot, true);
    assert.equal(seeded.normalizedHasCwd, true);
    if (exportFixture) {
      assert(fs.existsSync(path.join(path.resolve(exportFixture), "manifest.json")));
      assert(fs.existsSync(path.join(path.resolve(exportFixture), "openclaw-agent.sqlite")));
    }
    const readByParent = invoke("inspect", parent);
    assert.equal(readByParent.rawHasRoot, true);
    assert.equal(readByParent.rawHasCwd, true);
    assert.equal(readByParent.normalizedHasRoot, false);
    assert.equal(readByParent.normalizedHasCwd, schema === 20);
    assert.equal(invoke("parent-unrelated-write", parent).originalRootPreserved, true);
    const parentReplacement = invoke("parent-binding-replacement", parent);
    assert.equal(parentReplacement.rawHasRoot, false);
    assert.equal(parentReplacement.rawHasCwd, schema === 20);
    assert.equal(parentReplacement.normalizedHasRoot, false);
    assert.equal(parentReplacement.normalizedHasCwd, schema === 20);
    const afterParentReplacement = invoke("inspect", candidate);
    assert.equal(afterParentReplacement.normalizedHasRoot, false);
    assert.equal(afterParentReplacement.normalizedHasCwd, schema === 20);
    const candidateReplacement = invoke("candidate-binding-replacement", candidate);
    assert.equal(candidateReplacement.replacementRootStored, true);
    assert.equal(candidateReplacement.replacementCwdStored, true);
    assert.equal(invoke("inspect", candidate).replacementRootStored, true);
    if (upgradeFixture) {
      const upgraded = invoke("upgrade-fixture", candidate, [
        "--upgrade-fixture",
        path.resolve(upgradeFixture),
      ]);
      assert.equal(upgraded.migration.from, 20);
      assert.equal(upgraded.migration.to, schema);
      assert.equal(upgraded.cwdPreserved, true);
      assert.equal(upgraded.transcriptRootPreserved, true);
      assert.equal(upgraded.reopenWritePreserved, true);
    }
    report.status = "passed";
    report.limitation =
      schema === 20
        ? "Schema-20 same-pair proof covers a parent that preserves cwd while dropping the new transcript root. The exported fixture is synthetic binding state; no live Claude transcript canary is included. This is not a stable-release schema downgrade proof."
        : "Schema-23 same-pair proof covers the current parent dropping both cwd and transcriptRoot while preserving unrelated raw state. The schema-20 fixture was upgraded through the canonical maintenance lease and reopened/written by the candidate. The fixture is synthetic binding state; no live Claude transcript canary is included. No downgrade is claimed.";
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
      for (const linked of dependencyLinks) {
        fs.unlinkSync(linked);
      }
      execFileSync("git", ["worktree", "remove", parent]);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`Compatibility proof: ${report.status}`);
}

if (args.includes("--phase")) {
  await phase();
} else {
  await main();
}
