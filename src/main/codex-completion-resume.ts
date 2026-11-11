import { AttentionItem } from "../shared/attention";
import { CodexInstance, CodexInstancesSnapshot } from "../shared/codex-instances";
import { CodexMessageReceipt } from "../shared/codex-message";
import { CodexMessage } from "./codex-attachments";

const projectKey = (value: string) => value.replace(/^\\\\\?\\/, "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** Resume a saved completion thread through a live instance in its original project. */
export function createCodexCompletionResume(instances: { refresh(): Promise<CodexInstancesSnapshot> },
  projects: { send(instance: CodexInstance, sessionId: string, message: CodexMessage): Promise<CodexMessageReceipt> }) {
  return async (item: AttentionItem, message: CodexMessage): Promise<CodexMessageReceipt> => {
    if (item.source !== "codex" || !/^completion-[a-f0-9]{64}$/.test(item.id) || !item.codexSessionId || !item.project) {
      throw new Error("This completion has no verified Codex project session.");
    }
    const matches = (await instances.refresh()).instances.filter(instance =>
      instance.workspace && projectKey(instance.workspace) === projectKey(item.project!));
    const origin = item.origin;
    const instance = matches.find(candidate => origin?.kind === "vscode-codex" &&
      candidate.codexPid === origin.codexPid && candidate.codexStartedAt === origin.codexStartedAt &&
      candidate.vscodePid === origin.vscodePid && candidate.vscodeStartedAt === origin.vscodeStartedAt) || matches[0];
    if (!instance) throw new Error("No running Codex instance is available for this project. Open it in VS Code and try again.");
    // CodexProjectSessions.send verifies the live process and thread cwd before delivery.
    return projects.send(instance, item.codexSessionId, message);
  };
}
