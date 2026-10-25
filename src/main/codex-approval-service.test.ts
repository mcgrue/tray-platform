import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { AttentionService } from "./attention-service";
import { CodexApprovalService } from "./codex-approval-service";
import { CODEX_APPROVAL_SOURCE as source } from "../shared/codex-approval";
import { CodexInstance } from "../shared/codex-instances";

const instance: CodexInstance = { codexPid: 42, codexStartedAt: "2026-10-25T10:00:00Z", vscodePid: 12,
  vscodeStartedAt: "2026-10-25T09:00:00Z", vscodeMainPid: 1, workspace: "D:/project", title: "Project" };
const command = "item/commandExecution/requestApproval", file = "item/fileChange/requestApproval";
const params = { threadId: "thread", turnId: "turn", itemId: "item", command: "echo café <script>literal</script>", cwd: "D:/project" };
let attention: AttentionService, service: CodexApprovalService, store: string;
beforeEach(async () => {
  store = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "tray-approvals-unit-")), "attention.json");
  attention = new AttentionService(store); await attention.initialize(); service = new CodexApprovalService(attention); await service.initialize();
});
afterEach(() => { service.close(); attention.close(); });
async function request(method = command, overrides = {}, proposal?: unknown, automaticAck = true) {
  const controller = new AbortController(); let ack!: () => void, fail!: (error: Error) => void;
  const responded = new Promise<void>((yes, no) => { ack = yes; fail = no; }); void responded.catch(() => {});
  const previous = new Set(attention.list().items.map(item => item.id)), wire: unknown[] = [];
  const result = service.request(instance, method, { ...params, ...overrides }, { requestId: 7, signal: controller.signal, responded }, proposal)
    .then(value => { wire.push(value); if (automaticAck) ack(); return value; }, error => ({ error: error.message }));
  while (!attention.list().items.some(item => !previous.has(item.id))) await new Promise(resolve => setTimeout(resolve, 1));
  const id = attention.list().items.find(item => !previous.has(item.id))!.id;
  return { id, wire, result, ack, abort() { controller.abort(); fail(new Error("Disconnected")); } };
}

test.each(["accept", "decline"] as const)("%s sends only a one-time decision and archives the request", async decision => {
  const f = await request();
  expect(f.wire).toEqual([]); expect(service.get(source, f.id).details).toContain(params.command);
  const receipt = await service.decide(source, f.id, decision);
  expect(await f.result).toEqual({ decision });
  expect(receipt.approval.status).toBe(decision === "accept" ? "allowed" : "declined");
  expect(attention.get(source, f.id)?.state).toBe("done");
  await service.decide(source, f.id, decision === "accept" ? "decline" : "accept"); expect(f.wire).toHaveLength(1);
});

test("simultaneous conflicting clients share the first decision and wait for its transport write", async () => {
  const f = await request(command, {}, undefined, false);
  const first = service.decide(source, f.id, "accept"), second = service.decide(source, f.id, "decline");
  let finished = false; void first.then(() => { finished = true; });
  await f.result; expect(finished).toBe(false); expect(f.wire).toEqual([{ decision: "accept" }]);
  f.ack(); expect(await first).toEqual(await second);
  expect(service.get(source, f.id).status).toBe("allowed");
});

test("same wire ID in another runtime gets a different card and cannot inherit a decision", async () => {
  const first = await request(), second = await request();
  expect(first.id).not.toBe(second.id);
  await service.decide(source, first.id, "accept"); expect(second.wire).toEqual([]);
  second.abort(); expect(await second.result).toHaveProperty("error");
});

test("expired requests cannot send a decision, even before the card update finishes", async () => {
  const f = await request(); f.abort();
  expect((await service.decide(source, f.id, "accept")).approval.status).toBe("expired");
  expect(await f.result).toHaveProperty("error"); expect(f.wire).toEqual([]);
});

test("disconnect after dispatch is unknown and never replayed", async () => {
  const f = await request(command, {}, undefined, false), delivery = service.decide(source, f.id, "accept");
  await f.result; f.abort();
  expect((await delivery).approval.status).toBe("unknown");
  await service.decide(source, f.id, "accept"); expect(f.wire).toHaveLength(1);
});

test.each([["pending", "expired"], ["sending", "unknown"]] as const)("new service makes persisted %s requests %s without reviving authority", async (status, expected) => {
  const f = await request();
  await attention.updateApproval(f.id, { ...service.get(source, f.id), status });
  const restartedAttention = new AttentionService(store); await restartedAttention.initialize();
  const restarted = new CodexApprovalService(restartedAttention); await restarted.initialize();
  expect((await restarted.decide(source, f.id, "accept")).approval.status).toBe(expected);
  expect(restartedAttention.get(source, f.id)?.state).toBe("done"); expect(f.wire).toEqual([]);
  restarted.close(); restartedAttention.close(); f.abort();
});

test("Done and Reopen cannot resolve an approval", async () => {
  const f = await request();
  for (const state of ["done", "pending"] as const) await expect(attention.setState(source, f.id, state)).rejects.toThrow("approval controls");
  expect(f.wire).toEqual([]); f.abort();
});

test("file approval requires complete proposed changes", async () => {
  const missing = await request(file);
  await expect(service.decide(source, missing.id, "accept")).rejects.toThrow("unavailable");
  await service.decide(source, missing.id, "decline");
  const changes = [{ path: "D:/project/file.ts", kind: { type: "update" }, diff: "-old\n+new" }];
  const complete = await request(file, {}, { type: "fileChange", changes });
  expect(service.get(source, complete.id).details).toContain("File: D:/project/file.ts\nChange: update\n-old\n+new");
  await service.decide(source, complete.id, "accept"); expect(await complete.result).toEqual({ decision: "accept" });
});

test("honors available decisions and never substitutes a session-wide grant", async () => {
  const f = await request(command, { availableDecisions: ["acceptForSession", "cancel"] });
  await expect(service.decide(source, f.id, "accept")).rejects.toThrow("unavailable");
  await expect(service.decide(source, f.id, "acceptForSession")).rejects.toThrow("Allow once");
  await service.decide(source, f.id, "decline"); expect(await f.result).toEqual({ decision: "cancel" });
});

test("network requests identify their destination, and oversized previews disable Allow once", async () => {
  const network = await request(command, { networkApprovalContext: { host: "example.test", protocol: "https" } });
  expect(service.get(source, network.id)).toMatchObject({ kind: "network", canAllow: true });
  expect(service.get(source, network.id).details).toContain("example.test"); await service.decide(source, network.id, "decline");
  const large = await request(command, { command: "x".repeat(200001) });
  expect(service.get(source, large.id).canAllow).toBe(false); large.abort();
});

test("storage failure before dispatch never permits execution", async () => {
  const f = await request(); jest.spyOn(attention, "updateApproval").mockRejectedValue(new Error("Disk full"));
  expect((await service.decide(source, f.id, "accept")).approval.status).toBe("expired");
  expect(await f.result).toHaveProperty("error"); expect(f.wire).toEqual([]);
});

test("storage failure after dispatch reports the sent decision and never sends again", async () => {
  const f = await request(), update = attention.updateApproval.bind(attention);
  jest.spyOn(attention, "updateApproval").mockImplementation((id, value) => value.status === "allowed" ? Promise.reject(new Error("Disk full")) : update(id, value));
  const receipt = await service.decide(source, f.id, "accept");
  expect(receipt.approval.status).toBe("allowed"); expect(receipt.warning).toContain("storage");
  expect(service.get(source, f.id).status).toBe("allowed");
  expect(await service.decide(source, f.id, "decline")).toEqual(receipt); expect(f.wire).toEqual([{ decision: "accept" }]);
});
