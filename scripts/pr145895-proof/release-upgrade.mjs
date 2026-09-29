// Run each phase in a fresh process; the release and candidate own separate installs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const [phase, packageRoot, evidenceDir, expectedCommit] = process.argv.slice(2);
assert(["seed", "read", "write", "reopen"].includes(phase));
assert(packageRoot && evidenceDir && process.env.OPENCLAW_STATE_DIR);
const stateDir = process.env.OPENCLAW_STATE_DIR;
const storePath = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
const scope = { agentId: "main", sessionKey: "agent:main:release-upgrade", storePath };
const unrelatedScope = { ...scope, sessionKey: "agent:main:release-unrelated" };
const localId = "b3220628-af97-4b08-a1fd-bb80e165c372";
const nativeId = "6a2cb7b5-e349-415a-b5fa-e6cc4361b085";
const canary = "Published release transcript survives candidate maintenance";
const candidate = phase !== "seed";
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const requirePackage = createRequire(path.join(packageRoot, "package.json"));
const load = (name) =>
  import(pathToFileURL(requirePackage.resolve(`openclaw/plugin-sdk/${name}`)).href);
if (candidate) {
  assert(expectedCommit, "Candidate package requires an exact build commit");
  const buildInfo = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "dist/build-info.json"), "utf8"),
  );
  assert.equal(buildInfo.commit, expectedCommit);
}
const store = await load("session-store-runtime");
const transcript = await load("session-transcript-runtime");
const read = () => store.getSessionEntry(scope);
const transcriptScope = { ...scope, sessionId: localId };
const beforePath = path.join(evidenceDir, "release-state.json");
const binding = {
  sessionId: nativeId,
  resumeCheckpointId: "released-checkpoint",
  authEpoch: "released-non-secret-epoch",
  cwdHash: "a".repeat(64),
  mcpConfigHash: "b".repeat(64),
  reseedReceipt: {
    version: 1,
    localSessionId: localId,
    promptHash: "c".repeat(64),
    userTurnDisposition: "persisted",
  },
};

function inspectDatabase(filename) {
  assert(fs.existsSync(filename), `Missing database: ${path.basename(filename)}`);
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    return {
      userVersion: Number(db.prepare("PRAGMA user_version").get().user_version),
      integrity: "ok",
      foreignKeys: "ok",
    };
  } finally {
    db.close();
  }
}

if (phase === "seed") {
  assert.equal(manifest.version, "2026.9.6");
  await store.upsertSessionEntry({
    ...scope,
    entry: {
      sessionId: localId,
      updatedAt: Date.now(),
      label: "published-release-session",
      inputTokens: 41,
      cliSessionBindings: {
        "claude-cli": binding,
        "fixture-cli": { sessionId: "unrelated-native-binding" },
      },
      cliSessionIds: { "claude-cli": nativeId, "fixture-cli": "unrelated-native-binding" },
    },
  });
  await store.upsertSessionEntry({
    ...unrelatedScope,
    entry: {
      sessionId: "e88997c3-7f35-4c75-8468-81c76fcb536f",
      updatedAt: Date.now(),
      label: "unrelated-release-session",
    },
  });
  assert(
    await transcript.appendSessionTranscriptMessageByIdentity({
      ...transcriptScope,
      message: { role: "user", content: canary, timestamp: Date.now() },
    }),
  );
  fs.writeFileSync(
    beforePath,
    JSON.stringify(
      {
        entry: read(),
        unrelated: store.getSessionEntry(unrelatedScope),
        schemas: manifest.openclaw.schemaVersions,
      },
      null,
      2,
    ),
  );
} else {
  const baseline = JSON.parse(fs.readFileSync(beforePath, "utf8"));
  const entry = read();
  assert(entry);
  assert.equal(entry.sessionId, localId);
  assert.equal(entry.inputTokens, baseline.entry.inputTokens);
  assert.equal(entry.cliSessionIds["claude-cli"], nativeId);
  assert.deepEqual(
    entry.cliSessionBindings["fixture-cli"],
    baseline.entry.cliSessionBindings["fixture-cli"],
  );
  for (const [key, value] of Object.entries(binding)) {
    assert.deepEqual(entry.cliSessionBindings["claude-cli"][key], value, key);
  }
  assert.deepEqual(store.getSessionEntry(unrelatedScope), baseline.unrelated);
  const cwd = path.join(stateDir, "workspace");
  const transcriptRoot = path.join(stateDir, "claude-profile", "projects");
  if (phase === "write") {
    assert(
      await store.patchSessionEntry({
        ...scope,
        update(current) {
          return {
            cliSessionBindings: {
              ...current.cliSessionBindings,
              "claude-cli": { ...current.cliSessionBindings["claude-cli"], cwd, transcriptRoot },
            },
            cliSessionIds: current.cliSessionIds,
            label: "candidate-write-survives-reopen",
          };
        },
      }),
    );
  }
  if (phase === "write" || phase === "reopen") {
    assert.equal(read().label, "candidate-write-survives-reopen");
    assert.equal(read().cliSessionBindings["claude-cli"].cwd, cwd);
    assert.equal(read().cliSessionBindings["claude-cli"].transcriptRoot, transcriptRoot);
  } else {
    assert.equal(entry.label, baseline.entry.label);
    assert.equal(entry.cliSessionBindings["claude-cli"].transcriptRoot, undefined);
  }
}

const events = await transcript.readSessionTranscriptEvents(transcriptScope);
assert(JSON.stringify(events).includes(canary), "Released transcript content was lost");
const observed = {
  phase,
  packageVersion: manifest.version,
  declaredSchemas: manifest.openclaw.schemaVersions,
  agent: inspectDatabase(storePath),
  state: inspectDatabase(path.join(stateDir, "state/openclaw.sqlite")),
  localSessionId: read().sessionId,
  nativeSessionId: read().cliSessionBindings["claude-cli"].sessionId,
  transcriptCanaryPreserved: true,
  transcriptDigest: createHash("sha256").update(JSON.stringify(events)).digest("hex"),
  status: "passed",
};
assert.equal(observed.agent.userVersion, observed.declaredSchemas.agent);
assert.equal(observed.state.userVersion, observed.declaredSchemas.state);
fs.writeFileSync(path.join(evidenceDir, `${phase}.json`), `${JSON.stringify(observed, null, 2)}\n`);
console.log(JSON.stringify(observed));
