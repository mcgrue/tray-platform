// Standalone hook helper: retain final-response raster images beyond temp cleanup.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createHash } = require("crypto");
const { fileURLToPath } = require("url");

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES = 5;
const imageSyntax = /!\[([^\]\r\n]*)\]\((?:<([^<>\r\n]+)>|([^()\s]+))\)/g;

function localImagePath(source) {
  let file = source;
  try { if (/^file:/i.test(file)) file = fileURLToPath(file); }
  catch { return; }
  if (file.startsWith("\\\\") || file.startsWith("//") || !path.isAbsolute(file) ||
      !/\.(?:png|jpe?g|gif|webp)$/i.test(file)) return;
  return file;
}

function imageExtension(bytes) {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString("ascii", 12, 16) === "IHDR") return ".png";
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ".jpg";
  if (bytes.length >= 13 && /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))) return ".gif";
  if (bytes.length >= 16 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return ".webp";
}

function retainCompletionImages(item, directory = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "tray-platform", "completion-images")) {
  if (item.source !== "codex" || !item.id.startsWith("completion-")) return item;
  let count = 0;
  const description = item.body.description.replace(imageSyntax, (original, alt, angled, plain) => {
    if (count >= MAX_IMAGES) return original;
    const file = localImagePath(angled || plain);
    if (!file) return original;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || !stat.size || stat.size > MAX_IMAGE_BYTES) return original;
      const bytes = fs.readFileSync(file), extension = imageExtension(bytes);
      if (!extension || bytes.length > MAX_IMAGE_BYTES) return original;
      const targetDirectory = path.join(directory, item.id);
      const target = path.join(targetDirectory, createHash("sha256").update(bytes).digest("hex") + extension);
      fs.mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
      try { fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o600 }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      count++;
      return `![${alt}](<${target.replace(/\\/g, "/")}>)`;
    } catch { return original; } // A missing or unreadable image must not hide the completion.
  });
  return description === item.body.description ? item : { ...item, body: { ...item.body, description } };
}

module.exports = { retainCompletionImages };
