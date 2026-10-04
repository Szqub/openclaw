import os from "node:os";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveAuthorizedClaudeCliBinding } from "../../agents/cli-runner/child-env.js";
import { captureTranscriptRedactionSnapshot } from "../../agents/transcript-redact-text.js";
import { readLegacyCompactionMetrics } from "../../config/sessions/legacy-compaction-history.js";
import type {
  ChatHistoryPage,
  ChatHistoryPageParams,
  ChatHistoryMessageParams,
} from "../../config/sessions/session-history-types.js";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import {
  prepareForwardedMessageCronJobNameResolver,
  projectForwardedMessages,
} from "../chat-display-projection.history.js";
import { resolveCurrentUserProfileDisplay } from "../current-user-profile-display.js";
import * as sessionTranscriptReaders from "../session-transcript-readers.js";
import { readChatHistoryPageKernel } from "./chat-history-page-kernel.js";
import { projectChatHistoryWithReplies } from "./chat-history-reply-messages.js";

function prepareChatHistoryParams<Params extends ChatHistoryPageParams>(input: Params) {
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
  return { params, sameAuthorization };
}

export async function readChatHistoryMessageById(input: ChatHistoryMessageParams) {
  const { params, sameAuthorization } = prepareChatHistoryParams(input);
  const readCanonical = () =>
    sessionTranscriptReaders.readSessionMessageByIdAsync(
      {
        agentId: input.sessionAgentId,
        sessionId: input.sessionId,
        sessionKey: input.canonicalKey,
        storePath: input.storePath,
        sessionEntry: input.entry,
      },
      input.messageId,
      {
        allowResetArchiveFallback: true,
        historyVisibility: { sessionStartedAt: input.entry?.sessionStartedAt },
      },
    );
  if (params.ignoreCliSessionImports || !input.storePath) {
    return readCanonical();
  }
  if (params.entry?.incognito || isIncognitoSessionKey(params.canonicalKey)) {
    const { readProcessHeldCliHistoryMessage } =
      await import("../cli-session-history.process-held.js");
    if (!sameAuthorization()) {
      return readCanonical();
    }
    const result = await readProcessHeldCliHistoryMessage(params);
    return sameAuthorization() ? result : readCanonical();
  }
  const { readSessionHistoryPageInWorker } =
    await import("../../config/sessions/session-history-worker-runtime.js");
  if (!sameAuthorization()) {
    return readCanonical();
  }
  const result = await readSessionHistoryPageInWorker({
    kind: "rpc-message",
    params: { ...params, storePath: input.storePath },
  });
  return sameAuthorization() ? result : readCanonical();
}

export async function readChatHistoryPage(
  input: ChatHistoryPageParams,
  signal?: AbortSignal,
): Promise<ChatHistoryPage> {
  signal?.throwIfAborted();
  const { params, sameAuthorization } = prepareChatHistoryParams(input);
  const readPage = async (pageParams: ChatHistoryPageParams): Promise<ChatHistoryPage> => {
    signal?.throwIfAborted();
    if (!sameAuthorization() && !pageParams.ignoreCliSessionImports) {
      return readPage({ ...input, ignoreCliSessionImports: true });
    }
    if (
      pageParams.sessionId &&
      pageParams.storePath &&
      (pageParams.entry?.incognito || isIncognitoSessionKey(pageParams.canonicalKey)) &&
      !pageParams.ignoreCliSessionImports
    ) {
      const { readProcessHeldCliHistory } = await import("../cli-session-history.process-held.js");
      if (!sameAuthorization() && !pageParams.ignoreCliSessionImports) {
        return readPage({ ...input, ignoreCliSessionImports: true });
      }
      const page = await readProcessHeldCliHistory(pageParams, signal);
      const refreshed = { ...page, messages: await refreshForwardedLabels(page.messages) };
      if (!sameAuthorization() && !pageParams.ignoreCliSessionImports) {
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
    if (!sameAuthorization() && !pageParams.ignoreCliSessionImports) {
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
    if (!sameAuthorization() && !pageParams.ignoreCliSessionImports) {
      return readPage({ ...input, ignoreCliSessionImports: true });
    }
    return page;
  };
  return readPage(params);
}

async function refreshForwardedLabels(messages: unknown[]): Promise<unknown[]> {
  return projectChatHistoryWithReplies(
    messages.filter(
      (message): message is Record<string, unknown> => asOptionalRecord(message) !== undefined,
    ),
    async (displayMessages) =>
      projectForwardedMessages(
        displayMessages,
        await prepareForwardedMessageCronJobNameResolver(displayMessages),
      ),
  );
}
