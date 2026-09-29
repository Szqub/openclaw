// Gateway CLI session history importer.
// Augments local chat history with bound external Claude CLI transcripts.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveAuthorizedClaudeCliBinding } from "../agents/cli-runner/child-env.js";
import type { SessionEntry } from "../config/sessions.js";
import { readClaudeCliSessionMessagesAsync } from "./cli-session-history.claude-snapshot.js";
import {
  type ClaudeCliFallbackSeed,
  CLAUDE_CLI_PROVIDER,
  readClaudeCliFallbackSeed,
  readClaudeCliSessionMessages,
  resolveClaudeCliBindingSessionId,
} from "./cli-session-history.claude.js";
import { mergeImportedChatHistoryMessages } from "./cli-session-history.merge.js";

const ANTHROPIC_PROVIDER = "anthropic";

export { readClaudeCliFallbackSeed, resolveClaudeCliBindingSessionId };
export type { ClaudeCliFallbackSeed };

type CliSessionHistoryParams = {
  entry: SessionEntry | undefined;
  provider?: string;
  localMessages: unknown[];
  homeDir?: string;
  cwd?: string;
  agentId?: string;
  preparedImportedMessages?: unknown[];
};

function resolveEligibleCliSessionBinding(params: CliSessionHistoryParams) {
  const provider = normalizeProviderId(params.provider ?? "");
  const eligible =
    !provider ||
    params.localMessages.length === 0 ||
    provider === CLAUDE_CLI_PROVIDER ||
    provider === ANTHROPIC_PROVIDER;
  // A retained location is continuity metadata, not authority to read a previous
  // profile. Check before native discovery, including when merging a prepared snapshot.
  return eligible ? resolveAuthorizedClaudeCliBinding(params) : undefined;
}

/** Resolves chat history plus whether a bound external transcript was actually incorporated. */
export function resolveChatHistoryWithCliSessionImports(params: CliSessionHistoryParams): {
  messages: unknown[];
  imported: boolean;
  expanded: boolean;
} {
  const binding = resolveEligibleCliSessionBinding(params);
  if (!binding) {
    return { messages: params.localMessages, imported: false, expanded: false };
  }
  const importedMessages =
    params.preparedImportedMessages ??
    readClaudeCliSessionMessages({
      cliSessionId: binding.sessionId,
      homeDir: params.homeDir,
      cwd: binding.cwd ?? params.cwd,
      projectsRoot: binding.transcriptRoot,
      localSessionId: params.entry?.sessionId,
      reseedReceipt: binding.reseedReceipt,
    });
  if (importedMessages.length === 0) {
    return { messages: params.localMessages, imported: false, expanded: false };
  }
  const messages = mergeImportedChatHistoryMessages({
    localMessages: params.localMessages,
    importedMessages,
  });
  return {
    messages,
    imported: messages !== params.localMessages,
    expanded: messages.length > params.localMessages.length,
  };
}

/** Acquires one request-local redacted view of the process-owned external snapshot. */
export async function readChatHistoryCliSessionImportSnapshot(
  params: CliSessionHistoryParams,
): Promise<unknown[]> {
  const binding = resolveEligibleCliSessionBinding(params);
  if (!binding) {
    return [];
  }
  const messages = await readClaudeCliSessionMessagesAsync({
    cliSessionId: binding.sessionId,
    homeDir: params.homeDir,
    cwd: binding.cwd ?? params.cwd,
    projectsRoot: binding.transcriptRoot,
    localSessionId: params.entry?.sessionId,
    reseedReceipt: binding.reseedReceipt,
  });
  const current = resolveEligibleCliSessionBinding(params);
  return current?.sessionId === binding.sessionId &&
    current.transcriptRoot === binding.transcriptRoot
    ? messages
    : [];
}
