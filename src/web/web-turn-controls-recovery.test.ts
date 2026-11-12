import { randomUUID } from "crypto";
import { WebAttentionBridge } from "./web-attention-bridge";

test("a recovered active-turn rejection unlocks phone sending without claiming delivery", async () => {
  const originalFetch = Object.getOwnPropertyDescriptor(global, "fetch");
  const originalStorage = Object.getOwnPropertyDescriptor(global, "sessionStorage");
  const originalCrypto = Object.getOwnPropertyDescriptor(global, "crypto");
  const values = new Map<string, string>();
  Object.defineProperty(global, "sessionStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => values.set(key, value),
  } });
  Object.defineProperty(global, "crypto", { configurable: true, value: { randomUUID } });
  const fetchMock = jest.fn(async (url: string) => {
    if (url.endsWith("/messages")) throw new Error("Response lost");
    const value = url.startsWith("/api/requests/") ? { state: "rejected", error: "Codex is working" } : { items: [] };
    return { ok: true, status: 200, json: async () => value };
  });
  Object.defineProperty(global, "fetch", { configurable: true, value: fetchMock });
  const bridge = new WebAttentionBridge(() => {}, () => {});
  (bridge as any).token = "fixture";
  const recovered = jest.fn(); bridge.onRecoveredCodexInstanceMessage(recovered);
  try {
    await expect(bridge.sendCodexInstanceMessage({ codexPid: 42, codexStartedAt: "2026-11-11T10:00:00Z" },
      "saved", "Plan later", { mode: "plan" })).rejects.toThrow("Delivery is unconfirmed");
    expect(bridge.pendingCount).toBe(1);
    await bridge.checkDeliveries();
    expect(bridge.pendingCount).toBe(0);
    expect(recovered).not.toHaveBeenCalled();
  } finally {
    bridge.close();
    for (const [key, descriptor] of [["fetch", originalFetch], ["sessionStorage", originalStorage], ["crypto", originalCrypto]] as const) {
      if (descriptor) Object.defineProperty(global, key, descriptor); else delete (global as any)[key];
    }
  }
});
