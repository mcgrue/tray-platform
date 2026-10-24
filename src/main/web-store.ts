import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";

/** Atomic replacement; failed temporary writes are retained for diagnosis. */
export async function writeWebStore(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value), "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temporary, file);
}

export async function readWebStore<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}
