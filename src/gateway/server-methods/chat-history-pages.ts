import os from "node:os";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveAuthorizedClaudeCliBinding } from "../../agents/cli-runner/child-env.js";
import { captureTranscriptRedactionSnapshot } from "../../agents/transcript-redact-text.js";
import { readLegacyCompactionMetrics } from "../../config/sessions/legacy-compaction-history.js";
import type {
  ChatHistoryPage,
  ChatHistoryPageParams,
} from "../../config/sessions/session-history-types.js";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import {
  prepareForwardedMessageCronJobNameResolver,
  projectForwardedMessages,
} from "../chat-display-projection.history.js";
import { resolveCurrentUserProfileDisplay } from "../current-user-profile-display.js";
import * as sessionTranscriptReaders from "../session-transcript-readers.js";
import { readChatHistoryPageKernel } from "./chat-history-page-kernel.js";

export async function readChatHistoryPage(
  input: ChatHistoryPageParams,
  signal?: AbortSignal,
): Promise<ChatHistoryPage> {
  signal?.throwIfAborted();
  const homeDir = process.env.HOME || os.homedir();
  const authorization = !input.ignoreCliSessionImports
    ? resolveAuthorizedClaudeCliBinding({
        entry: input.entry,
        agentId: input.sessionAgentId,
        cwd: input.cwd,
        homeDir,
      })
    : undefined;
  const params = authorization
    ? {
        ...input,
        cliHistoryHomeDir: homeDir,
        cliHistoryRedaction: captureTranscriptRedactionSnapshot(),
        cliHistoryProjectsRoot: authorization.transcriptRoot,
      }
    : { ...input, ignoreCliSessionImports: true };
  const sameAuthorization = () => {
    if (!authorization) {
      return true;
    }
    const currentHomeDir = process.env.HOME || os.homedir();
    const current = resolveAuthorizedClaudeCliBinding({
      entry: input.entry,
      agentId: input.sessionAgentId,
      cwd: input.cwd,
      homeDir: currentHomeDir,
    });
    return JSON.stringify(current) === JSON.stringify(authorization);
  };
  const readPage = async (pageParams: ChatHistoryPageParams): Promise<ChatHistoryPage> => {
    signal?.throwIfAborted();
    if (authorization && !sameAuthorization() && !pageParams.ignoreCliSessionImports) {
      return readPage({ ...input, ignoreCliSessionImports: true });
    }
    if (
      pageParams.sessionId &&
      pageParams.storePath &&
      (pageParams.entry?.incognito || isIncognitoSessionKey(pageParams.canonicalKey)) &&
      !pageParams.ignoreCliSessionImports
    ) {
      const { readProcessHeldCliHistory } = await import("../cli-session-history.process-held.js");
      if (authorization && !sameAuthorization() && !pageParams.ignoreCliSessionImports) {
        return readPage({ ...input, ignoreCliSessionImports: true });
      }
      const page = await readProcessHeldCliHistory(pageParams, signal);
      const refreshed = { ...page, messages: await refreshForwardedLabels(page.messages) };
      if (authorization && !sameAuthorization() && !pageParams.ignoreCliSessionImports) {
        return readPage({ ...input, ignoreCliSessionImports: true });
      }
      return refreshed;
    }
    if (
      !pageParams.sessionId ||
      !pageParams.storePath ||
      pageParams.entry?.incognito ||
      isIncognitoSessionKey(pageParams.canonicalKey)
    ) {
      const page = await readChatHistoryPageKernel(pageParams, {
        readers: sessionTranscriptReaders,
        resolveCurrentUserProfileDisplay,
        resolveCronJobName: () => undefined,
      });
      return { ...page, messages: await refreshForwardedLabels(page.messages) };
    }
    const { readSessionHistoryPageInWorker } =
      await import("../../config/sessions/session-history-worker-runtime.js");
    if (authorization && !sameAuthorization() && !pageParams.ignoreCliSessionImports) {
      return readPage({ ...input, ignoreCliSessionImports: true });
    }
    const page = await readSessionHistoryPageInWorker(
      {
        kind: "rpc",
        params: {
          ...pageParams,
          compactionMetrics: readLegacyCompactionMetrics(pageParams.entry),
          sessionId: pageParams.sessionId,
          storePath: pageParams.storePath,
        },
      },
      signal,
    );
    if (authorization && !sameAuthorization() && !pageParams.ignoreCliSessionImports) {
      return readPage({ ...input, ignoreCliSessionImports: true });
    }
    return page;
  };
  return readPage(params);
}

async function refreshForwardedLabels(messages: unknown[]): Promise<unknown[]> {
  const resolveCronJobName = await prepareForwardedMessageCronJobNameResolver(messages);
  return projectForwardedMessages(
    messages.filter(
      (message): message is Record<string, unknown> => asOptionalRecord(message) !== undefined,
    ),
    resolveCronJobName,
  );
}
