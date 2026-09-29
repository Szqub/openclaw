// Native transcript locations are independent fixtures, including wrong-root decoys.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as cliBackends from "../agents/cli-backends.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import * as nativeSnapshot from "./cli-session-history.claude-snapshot.js";
import * as nativeHistory from "./cli-session-history.claude.js";
import {
  readChatHistoryCliSessionImportSnapshot,
  resolveChatHistoryWithCliSessionImports,
} from "./cli-session-history.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionId = "native-history-session";

async function writeTranscript(root: string, text: string) {
  // Native resume can find a session after its project folder has moved.
  const projectDir = path.join(root, "projects", "moved-project");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, `${sessionId}.jsonl`),
    JSON.stringify({
      type: "assistant",
      uuid: "native-assistant",
      timestamp: "2026-09-01T10:00:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text }] },
    }) + "\n",
  );
}

async function fixture() {
  const root = await fs.realpath(tempDirs.make("openclaw-claude-history-root-"));
  const homeDir = path.join(root, "home");
  const cwd = path.join(root, "child cwd");
  await fs.mkdir(cwd, { recursive: true });
  vi.stubEnv("HOME", path.join(root, "different-home"));
  return { root, homeDir, cwd, cliSessionId: sessionId };
}

describe("Claude configured transcript roots", () => {
  it.each(["unset", "absolute", "relative", "empty", "unicode"] as const)(
    "reads the selected %s root consistently for sync, async, and fallback history",
    async (kind) => {
      const params = await fixture();
      const defaultRoot = path.join(params.homeDir, ".claude");
      const selectedRoot =
        kind === "unset"
          ? defaultRoot
          : kind === "empty"
            ? params.cwd
            : kind === "relative"
              ? path.join(params.cwd, "relative profile")
              : kind === "unicode"
                ? path.join(params.root, "café")
                : path.join(params.root, "selected profile");
      const configDir =
        kind === "unset"
          ? undefined
          : kind === "empty"
            ? ""
            : kind === "relative"
              ? "relative profile"
              : kind === "unicode"
                ? path.join(params.root, "cafe\u0301")
                : selectedRoot;
      vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
      if (selectedRoot !== defaultRoot) {
        await writeTranscript(defaultRoot, "Wrong default history");
      }
      await writeTranscript(selectedRoot, "Selected native history");
      const historyParams = {
        ...params,
        entry: {
          sessionId: "openclaw-session",
          updatedAt: 1,
          cliSessionBindings: {
            "claude-cli": {
              sessionId,
              cwd: params.cwd,
              transcriptRoot: path.join(selectedRoot, "projects"),
            },
          },
        },
        localMessages: [],
      };
      for (const result of [
        nativeHistory.readClaudeCliSessionMessages(params),
        await nativeSnapshot.readClaudeCliSessionMessagesAsync(params),
        nativeHistory.readClaudeCliFallbackSeed(params),
        resolveChatHistoryWithCliSessionImports(historyParams).messages,
        await readChatHistoryCliSessionImportSnapshot(historyParams),
      ]) {
        expect(JSON.stringify(result)).toContain("Selected native history");
        expect(JSON.stringify(result)).not.toContain("Wrong default history");
      }
    },
  );

  it("uses the current skill configuration to authorize a retained profile", async () => {
    const params = await fixture();
    const previousConfig = getRuntimeConfigSnapshot();
    const childRoot = path.join(params.root, "skill profile");
    await writeTranscript(childRoot, "Skill-selected native history");
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    const lookup = {
      ...params,
      localMessages: [],
      entry: {
        sessionId: "openclaw-session",
        updatedAt: 1,
        skillsSnapshot: { prompt: "", skills: [{ name: "native-profile" }] },
        cliSessionBindings: {
          "claude-cli": {
            sessionId,
            cwd: params.cwd,
            transcriptRoot: path.join(childRoot, "projects"),
          },
        },
      },
    };
    const reader = vi.spyOn(nativeSnapshot, "readClaudeCliSessionMessagesAsync");
    try {
      setRuntimeConfigSnapshot({
        skills: { entries: { "native-profile": { env: { CLAUDE_CONFIG_DIR: childRoot } } } },
      });
      expect(JSON.stringify(await readChatHistoryCliSessionImportSnapshot(lookup))).toContain(
        "Skill-selected native history",
      );
      expect(reader).toHaveBeenCalledOnce();
      reader.mockClear();
      setRuntimeConfigSnapshot({ skills: { entries: { "native-profile": { enabled: false } } } });
      expect(await readChatHistoryCliSessionImportSnapshot(lookup)).toEqual([]);
      expect(reader).not.toHaveBeenCalled();
    } finally {
      reader.mockRestore();
      if (previousConfig) {
        setRuntimeConfigSnapshot(previousConfig);
      } else {
        clearRuntimeConfigSnapshot();
      }
    }
  });

  it.each(["spawned-cwd", "run-cwd", "spawned-workspace", "workspace"] as const)(
    "resolves legacy relative history from %s without caller-specific cwd inference",
    async (kind) => {
      const params = await fixture();
      const previousConfig = getRuntimeConfigSnapshot();
      const selectedCwd = path.join(params.root, "selected cwd");
      await fs.mkdir(selectedCwd);
      await writeTranscript(path.join(selectedCwd, "relative profile"), "Legacy relative history");
      vi.stubEnv("CLAUDE_CONFIG_DIR", "relative profile");
      const lookup = {
        agentId: "main",
        homeDir: params.homeDir,
        localMessages: [],
        entry: {
          sessionId: "openclaw-session",
          updatedAt: 1,
          cliSessionBindings: { "claude-cli": { sessionId } },
          ...(kind === "spawned-cwd" ? { spawnedCwd: selectedCwd } : {}),
          ...(kind === "spawned-workspace" ? { spawnedWorkspaceDir: selectedCwd } : {}),
        },
      };
      try {
        setRuntimeConfigSnapshot({
          agents: {
            list: [
              {
                id: "main",
                cwd: kind === "run-cwd" ? selectedCwd : undefined,
                workspace:
                  kind === "workspace" ? selectedCwd : path.join(params.root, "wrong workspace"),
              },
            ],
          },
        });
        expect(
          JSON.stringify(await readChatHistoryCliSessionImportSnapshot(lookup)),
          "LEGACY_HISTORY_CWD: legacy imports must resolve the selected agent directory",
        ).toContain("Legacy relative history");
        expect(JSON.stringify(resolveChatHistoryWithCliSessionImports(lookup).messages)).toContain(
          "Legacy relative history",
        );
      } finally {
        if (previousConfig) {
          setRuntimeConfigSnapshot(previousConfig);
        } else {
          clearRuntimeConfigSnapshot();
        }
      }
    },
  );

  it.each(["override", "clear"] as const)(
    "authorizes retained history using the backend's current %s environment",
    async (kind) => {
      const params = await fixture();
      const selectedRoot =
        kind === "clear"
          ? path.join(params.homeDir, ".claude")
          : path.join(params.root, "backend profile");
      await writeTranscript(selectedRoot, "Backend-selected native history");
      vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(params.root, "gateway profile"));
      const backend = vi.spyOn(cliBackends, "resolveCliBackendConfig").mockReturnValue({
        id: "claude-cli",
        bundleMcp: false,
        config: {
          command: "claude",
          ...(kind === "clear"
            ? { clearEnv: ["CLAUDE_CONFIG_DIR"] }
            : { env: { CLAUDE_CONFIG_DIR: selectedRoot } }),
        },
      });
      const reader = vi.spyOn(nativeSnapshot, "readClaudeCliSessionMessagesAsync");
      const lookup = {
        ...params,
        localMessages: [],
        entry: {
          sessionId: "openclaw-session",
          updatedAt: 1,
          cliSessionBindings: {
            "claude-cli": {
              sessionId,
              cwd: params.cwd,
              transcriptRoot: path.join(selectedRoot, "projects"),
            },
          },
        },
      };
      try {
        expect(JSON.stringify(await readChatHistoryCliSessionImportSnapshot(lookup))).toContain(
          "Backend-selected native history",
        );
        expect(reader).toHaveBeenCalledOnce();
        reader.mockClear();
        backend.mockReturnValue({
          id: "claude-cli",
          bundleMcp: false,
          config: {
            command: "claude",
            env: { CLAUDE_CONFIG_DIR: path.join(params.root, "new backend profile") },
          },
        });
        expect(await readChatHistoryCliSessionImportSnapshot(lookup)).toEqual([]);
        expect(reader).not.toHaveBeenCalled();
      } finally {
        backend.mockRestore();
        reader.mockRestore();
      }
    },
  );

  it("does not guess a relative root when the child cwd is unknown", async () => {
    const { homeDir } = await fixture();
    vi.stubEnv("CLAUDE_CONFIG_DIR", "relative profile");
    await writeTranscript(path.join(homeDir, ".claude"), "Wrong default history");
    const params = { cliSessionId: sessionId, homeDir };
    expect(nativeHistory.readClaudeCliSessionMessages(params)).toEqual([]);
    expect(await nativeSnapshot.readClaudeCliSessionMessagesAsync(params)).toEqual([]);
    expect(nativeHistory.readClaudeCliFallbackSeed(params)).toBeUndefined();
  });

  it("does not resolve a node-placed rootless binding against Gateway files", async () => {
    const params = await fixture();
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    await writeTranscript(path.join(params.homeDir, ".claude"), "Stale Gateway-native history");
    const lookup = {
      ...params,
      localMessages: [],
      entry: {
        sessionId: "openclaw-session",
        updatedAt: 1,
        execHost: "node" as const,
        execNode: "fixture-node",
        cliSessionBindings: { "claude-cli": { sessionId } },
      },
    };
    const syncReader = vi.spyOn(nativeHistory, "readClaudeCliSessionMessages");
    const asyncReader = vi.spyOn(nativeSnapshot, "readClaudeCliSessionMessagesAsync");
    try {
      expect(await readChatHistoryCliSessionImportSnapshot(lookup)).toEqual([]);
      expect(resolveChatHistoryWithCliSessionImports(lookup).imported).toBe(false);
      expect(syncReader).not.toHaveBeenCalled();
      expect(asyncReader).not.toHaveBeenCalled();
    } finally {
      syncReader.mockRestore();
      asyncReader.mockRestore();
    }
  });

  it("resolves a symlinked child cwd before the relative parent path", async () => {
    const params = await fixture();
    const physicalCwd = path.join(params.root, "physical", "child");
    const logicalCwd = path.join(params.root, "logical");
    await fs.mkdir(physicalCwd, { recursive: true });
    await fs.symlink(physicalCwd, logicalCwd, process.platform === "win32" ? "junction" : "dir");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "../profile");
    await writeTranscript(path.join(params.root, "profile"), "Wrong lexical parent");
    await writeTranscript(path.join(params.root, "physical", "profile"), "Physical native history");
    const lookup = { ...params, cwd: logicalCwd };
    for (const messages of [
      nativeHistory.readClaudeCliSessionMessages(lookup),
      await nativeSnapshot.readClaudeCliSessionMessagesAsync(lookup),
    ]) {
      expect(JSON.stringify(messages)).toContain("Physical native history");
      expect(JSON.stringify(messages)).not.toContain("Wrong lexical parent");
    }
  });

  it.each(["retained", "legacy"] as const)(
    "reads a reloaded %s binding through the root the child actually used",
    async (kind) => {
      const params = await fixture();
      const childRoot = path.join(params.root, "child profile");
      const gatewayRoot = path.join(params.root, "gateway profile");
      await writeTranscript(gatewayRoot, "Wrong gateway history");
      await writeTranscript(childRoot, "Child native history");
      vi.stubEnv("CLAUDE_CONFIG_DIR", childRoot);
      const entry = {
        sessionId: "openclaw-session",
        updatedAt: Date.now(),
        cliSessionBindings: {
          "claude-cli": {
            sessionId,
            cwd: params.cwd,
            ...(kind === "retained" ? { transcriptRoot: path.join(childRoot, "projects") } : {}),
          },
        },
      };
      const lookup = { entry, provider: "claude-cli", localMessages: [], homeDir: params.homeDir };
      const syncReader = vi.spyOn(nativeHistory, "readClaudeCliSessionMessages");
      const asyncReader = vi.spyOn(nativeSnapshot, "readClaudeCliSessionMessagesAsync");
      for (const result of [
        resolveChatHistoryWithCliSessionImports(lookup),
        resolveChatHistoryWithCliSessionImports({
          ...lookup,
          preparedImportedMessages: await readChatHistoryCliSessionImportSnapshot(lookup),
        }),
      ]) {
        expect(JSON.stringify(result.messages)).toContain("Child native history");
        expect(JSON.stringify(result.messages)).not.toContain("Wrong gateway history");
      }
      expect(syncReader).toHaveBeenCalledOnce();
      expect(asyncReader).toHaveBeenCalledOnce();
      syncReader.mockRestore();
      asyncReader.mockRestore();
    },
  );

  it.each(["changed", "unset"] as const)(
    "rejects a %s profile before retained native-history I/O",
    async (kind) => {
      const params = await fixture();
      const childRoot = path.join(params.root, "child profile");
      await writeTranscript(childRoot, "Retained native history");
      vi.stubEnv("CLAUDE_CONFIG_DIR", childRoot);
      const entry = {
        sessionId: "openclaw-session",
        updatedAt: 1,
        cliSessionBindings: {
          "claude-cli": {
            sessionId,
            cwd: params.cwd,
            transcriptRoot: path.join(childRoot, "projects"),
            forceReuse: true,
            authProfileId: "retired-profile",
          },
        },
      };
      const localMessages = [{ role: "user", content: "Local history survives" }];
      const lookup = { entry, provider: "claude-cli", localMessages, homeDir: params.homeDir };
      const preparedImportedMessages = await readChatHistoryCliSessionImportSnapshot(lookup);
      expect(JSON.stringify(preparedImportedMessages)).toContain("Retained native history");
      vi.stubEnv(
        "CLAUDE_CONFIG_DIR",
        kind === "changed" ? path.join(params.root, "new profile") : undefined,
      );
      const syncReader = vi.spyOn(nativeHistory, "readClaudeCliSessionMessages");
      const asyncReader = vi.spyOn(nativeSnapshot, "readClaudeCliSessionMessagesAsync");
      try {
        expect(
          await readChatHistoryCliSessionImportSnapshot(lookup),
          "CURRENT_PROFILE_READ_DENIED: changed profiles must not import retained history",
        ).toEqual([]);
        for (const request of [lookup, { ...lookup, preparedImportedMessages }]) {
          expect(resolveChatHistoryWithCliSessionImports(request)).toEqual({
            messages: localMessages,
            imported: false,
            expanded: false,
          });
        }
        expect(syncReader).not.toHaveBeenCalled();
        expect(asyncReader).not.toHaveBeenCalled();
        expect(entry.cliSessionBindings["claude-cli"].transcriptRoot).toBe(
          path.join(childRoot, "projects"),
        );
      } finally {
        syncReader.mockRestore();
        asyncReader.mockRestore();
      }
    },
  );

  it.each(
    ["explicit", "configured-cwd", "workspace"].flatMap((source) =>
      ["relative profile", ""].map((configDir) => ({ source, configDir })),
    ),
  )(
    "rejects changed current cwd from $source for '$configDir' before native I/O",
    async ({ source, configDir }) => {
      const params = await fixture();
      const previousConfig = getRuntimeConfigSnapshot();
      const nextCwd = path.join(params.root, "next child cwd");
      await fs.mkdir(nextCwd);
      const retainedRoot = path.join(params.cwd, configDir, "projects");
      await writeTranscript(path.join(params.cwd, configDir), "Retained cwd native history");
      vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
      const configureCwd = (cwd: string) => {
        setRuntimeConfigSnapshot({
          agents: {
            list: [{ id: "main", ...(source === "configured-cwd" ? { cwd } : {}), workspace: cwd }],
          },
        });
      };
      const localMessages = [{ role: "user", content: "Canonical local history" }];
      const lookup = {
        agentId: "main",
        homeDir: params.homeDir,
        cwd: source === "explicit" ? params.cwd : undefined,
        localMessages,
        entry: {
          sessionId: "openclaw-session",
          updatedAt: 1,
          cliSessionBindings: {
            "claude-cli": { sessionId, cwd: params.cwd, transcriptRoot: retainedRoot },
          },
        },
      };
      const syncReader = vi.spyOn(nativeHistory, "readClaudeCliSessionMessages");
      const asyncReader = vi.spyOn(nativeSnapshot, "readClaudeCliSessionMessagesAsync");
      try {
        configureCwd(params.cwd);
        const preparedImportedMessages = await readChatHistoryCliSessionImportSnapshot(lookup);
        expect(JSON.stringify(preparedImportedMessages)).toContain("Retained cwd native history");
        expect(asyncReader).toHaveBeenCalledOnce();
        asyncReader.mockClear();
        configureCwd(nextCwd);
        if (source === "explicit") lookup.cwd = nextCwd;
        expect(
          await readChatHistoryCliSessionImportSnapshot(lookup),
          "CURRENT_CWD_READ_DENIED: a retained cwd must not authorize a former relative root",
        ).toEqual([]);
        for (const request of [lookup, { ...lookup, preparedImportedMessages }]) {
          expect(resolveChatHistoryWithCliSessionImports(request)).toEqual({
            messages: localMessages,
            imported: false,
            expanded: false,
          });
        }
        expect(syncReader).not.toHaveBeenCalled();
        expect(asyncReader).not.toHaveBeenCalled();
        expect(lookup.entry.cliSessionBindings["claude-cli"]).toEqual({
          sessionId,
          cwd: params.cwd,
          transcriptRoot: retainedRoot,
        });
      } finally {
        syncReader.mockRestore();
        asyncReader.mockRestore();
        if (previousConfig) setRuntimeConfigSnapshot(previousConfig);
        else clearRuntimeConfigSnapshot();
      }
    },
  );

  it("invalidates the imported snapshot when the selected profile changes", async () => {
    const params = await fixture();
    const firstRoot = path.join(params.root, "first-profile");
    const secondRoot = path.join(params.root, "second-profile");
    await writeTranscript(firstRoot, "History from profile A");
    await writeTranscript(secondRoot, "History from profile B");
    vi.stubEnv("CLAUDE_CONFIG_DIR", firstRoot);
    expect(
      JSON.stringify(await nativeSnapshot.readClaudeCliSessionMessagesAsync(params)),
    ).toContain("profile A");
    vi.stubEnv("CLAUDE_CONFIG_DIR", secondRoot);
    const messages = await nativeSnapshot.readClaudeCliSessionMessagesAsync(params);
    expect(JSON.stringify(messages)).toContain("profile B");
    expect(JSON.stringify(messages)).not.toContain("profile A");
  });
});
