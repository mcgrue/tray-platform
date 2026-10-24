import { externalLinkHandler } from "./external-links";

test("web links open externally without creating an Electron window", () => {
  const open = jest.fn(async () => {});
  const handler = externalLinkHandler(open);
  expect(handler({ url: "https://example.com/review" })).toEqual({ action: "deny" });
  expect(open).toHaveBeenCalledWith("https://example.com/review");
});

test.each(["file:///C:/secret", "javascript:alert(1)", "data:text/html,bad", "vscode://file/test", "/relative", "//example.com", "https://user:pass@example.com", "https://example.com\n", "https:\\example.com"])("never passes %s to the OS", url => {
  const open = jest.fn(async () => {});
  expect(externalLinkHandler(open)({ url })).toEqual({ action: "deny" });
  expect(open).not.toHaveBeenCalled();
});

test("handles an external browser launch failure", async () => {
  const error = new Error("Browser unavailable");
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(externalLinkHandler(async () => { throw error; })({ url: "https://example.com" })).toEqual({ action: "deny" });
    await Promise.resolve();
    expect(log).toHaveBeenCalledWith("Could not open attention link", error);
  } finally { log.mockRestore(); }
});
