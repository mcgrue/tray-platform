// Writes opt-in application configuration. Does not change Tailscale or restart the app.
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
function option(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
const directory = option("--user-data") || (process.platform === "win32" && path.join(process.env.APPDATA, "electron-from-scratch"));
if (!directory) throw new Error("Specify --user-data with Tray Platform's user data directory");
let origin = option("--origin"), login = option("--user");
if (process.argv.includes("--discover")) {
  const executable = process.platform === "win32" ? path.join(process.env.ProgramFiles, "Tailscale", "tailscale.exe") : "tailscale";
  const status = JSON.parse(execFileSync(executable, ["status", "--json"], { encoding: "utf8", windowsHide: true }));
  if (status.BackendState !== "Running" || !status.Self?.Online) throw new Error("Tailscale must be online");
  origin ||= `https://${status.Self.DNSName.replace(/\.$/, "")}`;
  login ||= status.User?.[status.Self.UserID]?.LoginName;
}
const url = new URL(origin), port = Number(option("--port") || 22223);
if (url.protocol !== "https:" || url.origin !== origin || !login || /[^\x21-\x7e]/.test(login) || !Number.isInteger(port) || port < 1024 || port > 65535 || port === 22222) throw new Error("Specify --origin https://host.ts.net --user tailscale-login and a separate port");
const config = { enabled: true, origin, allowedUsers: [login], port };
const file = path.join(directory, "web-config.json"), text = JSON.stringify(config, null, 2) + "\n";
fs.mkdirSync(directory, { recursive: true });
if (fs.existsSync(file)) {
  const existing = fs.readFileSync(file, "utf8");
  if (JSON.stringify(JSON.parse(existing)) === JSON.stringify(config)) { console.log("Configuration already matches:", file); process.exit(0); }
  if (!process.argv.includes("--replace")) throw new Error("Existing web config preserved. Review it or use --replace to keep a backup and replace it.");
  fs.copyFileSync(file, `${file}.${Date.now()}.bak`, fs.constants.COPYFILE_EXCL);
}
fs.writeFileSync(file, text, { mode: 0o600 });
console.log("Configured:", file);
console.log("Allowed Tailscale user:", login);
console.log("PWA URL:", origin);
console.log(`After restarting Tray Platform: tailscale serve --bg --https=443 http://127.0.0.1:${port}`);
