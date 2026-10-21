import { createCodexInstancesApi } from "./codex-instances-api";

test("exposes the snapshot only to loopback GET callers without browser Origin", async () => {
  const list = jest.fn(() => ({ instances: [], supported: true, scanning: false }));
  const api = createCodexInstancesApi({ list });
  for (const [address, origin, method, status] of [
    ["127.0.0.1", undefined, "GET", 200], ["::1", undefined, "GET", 200],
    ["100.1.2.3", undefined, "GET", 403], ["127.0.0.1", "https://example.com", "GET", 403],
    ["127.0.0.1", undefined, "POST", 405],
  ] as const) {
    const req = { url: "/api/codex-instances", method, socket: { remoteAddress: address }, headers: { origin } };
    const res = { writeHead: jest.fn(), end: jest.fn() };
    expect(await api(req as any, res as any)).toBe(true);
    expect(res.writeHead.mock.calls[0][0]).toBe(status);
  }
  expect(list).toHaveBeenCalledTimes(2);
  expect(await api({ url: "/api/attention" } as any, {} as any)).toBe(false);
});
