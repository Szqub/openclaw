import path from "node:path";
import { pathToFileURL } from "node:url";

const sessionKey = process.argv[2];
if (!sessionKey) throw new Error("session key required");
const load = (relative: string) => import(pathToFileURL(path.join(process.cwd(), relative)).href);
const { loadSessionEntryReadOnly } = await load(
  "src/config/sessions/session-accessor.sqlite-entry.ts",
);
const { getCliSessionBinding } = await load("src/config/sessions/cli-session-binding.ts");
const entry = loadSessionEntryReadOnly({
  agentId: "main",
  sessionKey,
  env: process.env,
  readConsistency: "latest",
  hydrateSkillPromptRefs: false,
});
const binding = getCliSessionBinding(entry, "claude-cli");
process.stdout.write(
  `${JSON.stringify({
    sessionKey,
    entryFound: Boolean(entry),
    entrySessionId: entry?.sessionId,
    bindingProviders: Object.keys(entry?.cliSessionBindings ?? {}),
    binding: binding
      ? {
          sessionId: binding.sessionId,
          transcriptRoot: binding.transcriptRoot,
          forkNextResume: binding.forkNextResume,
          forceReuse: binding.forceReuse,
        }
      : null,
  })}\n`,
);
