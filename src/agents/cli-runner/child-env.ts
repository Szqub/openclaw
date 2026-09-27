/** Composes the environment a CLI backend child receives and the Claude transcript root it selects. */
import { sanitizeHostExecEnv } from "../../infra/host-env-security.js";
import { resolveClaudeCliProjectsRootAsync } from "../command/claude-cli-project-dir.js";
import { CLI_BACKEND_PRESERVE_ENV, parseCliBackendPreserveEnv } from "./execute-logging.js";
import { isClaudeCliBackendId } from "./helpers.js";

export type CliChildEnv = {
  env: Record<string, string>;
  /** Claude projects root the child writes transcripts into, when it runs on this host. */
  claudeTranscriptRoot?: string;
};

export async function buildCliChildEnv(params: {
  provider: string;
  backendClearEnv?: readonly string[];
  selectedClaudeClearEnv?: ReadonlySet<string>;
  backendEnv: Record<string, string>;
  overlays: readonly (Record<string, string> | undefined)[];
  remote: boolean;
  cwd: string;
}): Promise<CliChildEnv> {
  const env = sanitizeHostExecEnv({ baseEnv: process.env, blockPathOverrides: true });
  const preservedEnv = parseCliBackendPreserveEnv(process.env[CLI_BACKEND_PRESERVE_ENV]);
  for (const key of params.backendClearEnv ?? []) {
    if (!preservedEnv.has(key) || params.selectedClaudeClearEnv?.has(key)) {
      delete env[key];
    }
  }
  if (Object.keys(params.backendEnv).length > 0) {
    Object.assign(
      env,
      sanitizeHostExecEnv({ baseEnv: {}, overrides: params.backendEnv, blockPathOverrides: true }),
    );
  }
  Object.assign(env, ...params.overlays);
  // Never mark Claude CLI as host-managed. That marker routes runs into
  // Anthropic's separate host-managed usage tier instead of normal CLI use.
  delete env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST;
  // Transcript discovery must follow the environment this child actually receives,
  // not the Gateway's own. A paired node writes its transcript on that node.
  const claudeTranscriptRoot =
    isClaudeCliBackendId(params.provider) && !params.remote
      ? await resolveClaudeCliProjectsRootAsync({ env, cwd: params.cwd })
      : undefined;
  return { env, ...(claudeTranscriptRoot ? { claudeTranscriptRoot } : {}) };
}

/** Projects the location a Claude binding must retain so later lookups skip Gateway state. */
export function claudeCliBindingLocation(
  provider: string,
  context: { cwd?: string; claudeTranscriptRoot?: string },
): { cwd?: string; transcriptRoot?: string } {
  if (!isClaudeCliBackendId(provider)) {
    return {};
  }
  return {
    ...(context.cwd ? { cwd: context.cwd } : {}),
    ...(context.claudeTranscriptRoot ? { transcriptRoot: context.claudeTranscriptRoot } : {}),
  };
}
