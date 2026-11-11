import { AttentionItem } from "../shared/attention";
import { CodexInstance } from "../shared/codex-instances";
import { CodexMessageService } from "./codex-message-service";
import { createCodexCompletionResume } from "./codex-completion-resume";

const completion: AttentionItem = {
  source: "codex", id: "completion-" + "a".repeat(64), title: "Done", codexSessionId: "saved-thread",
  project: "D:\\dev\\project", state: "pending", createdAt: 1, updatedAt: 1,
  origin: { kind: "vscode-codex", codexPid: 22, codexStartedAt: "2026-11-10T10:00:00Z",
    vscodePid: 12, vscodeStartedAt: "2026-11-10T09:00:00Z" },
};
const instance = (codexPid: number, workspace = "D:\\dev\\project"): CodexInstance => ({
  codexPid, codexStartedAt: "2026-11-10T10:00:00Z", vscodePid: 12,
  vscodeStartedAt: "2026-11-10T09:00:00Z", vscodeMainPid: 12, workspace, title: "Project",
});

test("resumes a completed thread only after an explicit owner-discovery miss", async () => {
  const client = { connect: jest.fn(async () => {}), close: jest.fn(),
    request: jest.fn(async (method: string) => ({ method, resultType: "error", error: "no-client-found" })) };
  const resume = jest.fn(async () => ({ sessionId: "saved-thread", turnId: "new-turn", delivery: "started" as const }));
  const service = new CodexMessageService(() => client as any, undefined, resume);
  await expect(service.send(completion, "Monitor CI")).resolves.toMatchObject({ turnId: "new-turn" });
  expect(client.request).toHaveBeenCalledTimes(1);
  expect(resume).toHaveBeenCalledWith(completion, "Monitor CI");
  expect(client.close).toHaveBeenCalledTimes(1);

  await expect(service.send({ ...completion, id: "question-" + "a".repeat(64) }, "Answer"))
    .rejects.toThrow("conversation is unavailable");
  expect(resume).toHaveBeenCalledTimes(1);
});

test("never resumes after a delivery rejection with uncertain admission", async () => {
  const client = { connect: jest.fn(async () => {}), close: jest.fn(), request: jest.fn(async (method: string) =>
    method === "thread-owner-discovery"
      ? { method, resultType: "success", handledByClientId: "owner", result: {} }
      : { method, resultType: "error", error: "no-client-found" }) };
  const resume = jest.fn();
  const service = new CodexMessageService(() => client as any, undefined, resume);
  await expect(service.send(completion, "Monitor CI")).rejects.toThrow("conversation is unavailable");
  expect(client.request).toHaveBeenCalledTimes(2);
  expect(resume).not.toHaveBeenCalled();
});

test("selects a refreshed instance in the completion project and prefers its original process", async () => {
  const other = instance(99, "D:\\dev\\other"), replacement = instance(44), original = instance(22);
  const refresh = jest.fn(async () => ({ instances: [other, replacement, original], scanning: false, supported: true }));
  const send = jest.fn(async () => ({ sessionId: "saved-thread", turnId: "new-turn", delivery: "started" as const }));
  const resume = createCodexCompletionResume({ refresh }, { send });
  await resume(completion, "Monitor CI");
  expect(send).toHaveBeenCalledWith(original, "saved-thread", "Monitor CI");
  await resume({ ...completion, origin: undefined, project: "d:/dev/project/" }, "Again");
  expect(send).toHaveBeenLastCalledWith(replacement, "saved-thread", "Again");
});

test("does not send through an unrelated project or an unverified completion", async () => {
  const refresh = jest.fn(async () => ({ instances: [instance(99, "D:\\dev\\other")], scanning: false, supported: true }));
  const send = jest.fn();
  const resume = createCodexCompletionResume({ refresh }, { send });
  await expect(resume(completion, "Monitor CI")).rejects.toThrow("No running Codex instance");
  await expect(resume({ ...completion, codexSessionId: undefined }, "Monitor CI")).rejects.toThrow("no verified Codex project session");
  expect(send).not.toHaveBeenCalled();
});
