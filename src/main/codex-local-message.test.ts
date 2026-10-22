import { AttentionItem } from "../shared/attention";
import { CodexMessageService } from "./codex-message-service";

const item: AttentionItem = {
  source: "codex", id: "local-question", title: "Local question", codexSessionId: "local-session",
  state: "pending", createdAt: 1, updatedAt: 1,
};

test.each([
  "Continue from Tray",
  '<send_user_message_question_reply>\n[{"questionItemId":"question","question":"Continue?","answer":"Yes"}]\n</send_user_message_question_reply>',
])("delivers an idle local message without invoking cloud-only admission: %s", async text => {
  const delivered: unknown[] = [];
  const client = {
    connect: jest.fn(async () => {}), close: jest.fn(),
    request: jest.fn(async (method: string, params: any, _version: number, owner?: string): Promise<any> => {
      if (method === "thread-owner-discovery") {
        return { method, resultType: "success", handledByClientId: "local-owner", result: {} };
      }
      expect(owner).toBe("local-owner");
      if (method === "thread-follower-steer-turn") {
        return { resultType: "error", error: `Cannot steer conversation ${item.codexSessionId} because its active turn already ended` };
      }
      // The installed VS Code client's local transport cannot use turn/addUserMessage.
      if (params.turnStart.context?.useUserMessageAdmission) {
        return { resultType: "error", error: "User-message admission requires a cloud app-server host" };
      }
      delivered.push(params.turnStart.request.input);
      return { method, resultType: "success", handledByClientId: owner, result: { result: { turn: { id: "local-turn" } } } };
    }),
  };
  const service = new CodexMessageService(() => client);
  await expect(service.send(item, text)).resolves.toEqual({ sessionId: "local-session", turnId: "local-turn", delivery: "started" });
  expect(delivered).toEqual([[{ type: "text", text, text_elements: [] }]]);
  expect(client.request).toHaveBeenCalledTimes(3);
  expect(client.close).toHaveBeenCalledTimes(1);
});
