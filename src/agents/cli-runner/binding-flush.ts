/** Probes whether a Claude CLI session binding reached its native transcript file. */
import { cliRunSettlementDeps, isClaudeCliBackend } from "./cli-run-settlement.js";

export async function isCliBindingFlushed(
  sessionId: string | undefined,
  provider: string | undefined,
  workspaceDir?: string,
  options?: { skipTranscriptProbe?: boolean; projectsRoot?: string },
): Promise<boolean> {
  if (!provider || !isClaudeCliBackend(provider)) {
    return true;
  }
  if (!sessionId) {
    return false;
  }
  // Warm-stdin sessions keep continuity in the managed stdio child and do not
  // write native transcripts. Probing them would always clear a valid binding.
  if (options?.skipTranscriptProbe) {
    return true;
  }
  const probe = { sessionId, workspaceDir, projectsRoot: options?.projectsRoot };
  for (const delayMs of [0, 50, 150]) {
    if (delayMs > 0) {
      await cliRunSettlementDeps.delay(delayMs);
    }
    if (await cliRunSettlementDeps.claudeCliSessionTranscriptHasContent(probe)) {
      return true;
    }
  }
  return false;
}
