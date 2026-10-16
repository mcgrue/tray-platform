import http from "http";
import { AddressInfo } from "net";
import { createServer } from "./webserver";

function request(server: http.Server, path: string, method = "GET"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: (server.address() as AddressInfo).port, path, method }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("legacy sound and speech requests retain their response without entering the inbox", async () => {
  const playSound = jest.fn();
  const sayWords = jest.fn();
  const server = createServer(0, { playSound, sayWords });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    expect(await request(server, "/DOCTEST_ALL_TESTS_PASS?say=Build%20finished")).toEqual({
      status: 200, body: "Hello from Electron's Main Process!",
    });
    expect(playSound).toHaveBeenCalledWith("fanfare");
    expect(sayWords).toHaveBeenCalledWith("Build finished");
    expect((await request(server, "/favicon.ico")).status).toBe(404);
    expect((await request(server, "/unrecognized")).status).toBe(200);
    expect(playSound).toHaveBeenCalledTimes(1);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("API responses bypass legacy handling and unsupported legacy methods terminate", async () => {
  const playSound = jest.fn();
  const server = createServer(0, {
    playSound,
    apiHandler: async (req, res) => {
      if (!req.url?.startsWith("/api/")) return false;
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
      return true;
    },
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    expect(await request(server, "/api/attention", "PUT")).toEqual({ status: 201, body: '{"ok":true}' });
    expect(playSound).not.toHaveBeenCalled();
    expect((await request(server, "/DOCTEST_ALL_TESTS_PASS", "POST")).status).toBe(405);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
