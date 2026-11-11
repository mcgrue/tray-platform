import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { attentionImageHref, localFileHref, localImageLink } from "../shared/attention-link";
import { attentionLocalImageLinks, renderAttentionMarkdown } from "../shared/attention-markdown";
import { AttentionService } from "./attention-service";
import { attentionFileResponse } from "./attention-files";

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==", "base64");

test("completion images render only from local raster Markdown image tokens", () => {
  const source = "C:/Users/me/Temp/pc-config.png";
  const href = localFileHref(localImageLink(source)!);
  const markdown = `![Updated PC Config screen](${source})\n\n![Remote](https://example.com/track.png)\n\n\`![Code](${source})\``;
  const html = renderAttentionMarkdown(markdown, { localImage: value => attentionImageHref({ source: "codex", id: "completion-1" }, value) });
  expect(html).toContain('class="attention-image"');
  expect(html).toContain('alt="Updated PC Config screen"');
  expect(html).toContain('src="/api/attention/codex/completion-1/file?target=');
  expect(html).toContain("&amp;inline=1");
  expect(html.match(/<img\b/g)).toHaveLength(1);
  expect(attentionLocalImageLinks(markdown)).toEqual([href]);
  expect(renderAttentionMarkdown(markdown)).not.toContain("<img");
  for (const invalid of ["https://example.com/x.png", "file://server/share/x.png", "C:/private/unsafe.svg", "C:/image.png:2"]) {
    expect(localImageLink(invalid)).toBeUndefined();
  }
});

test("inline image responses require an exact completion image and image bytes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tray-attention-images-"));
  const service = new AttentionService(path.join(directory, "attention.json"));
  try {
    await service.initialize();
    const image = path.join(directory, "screen.png");
    const other = path.join(directory, "other.png");
    await fs.writeFile(image, pixel); await fs.writeFile(other, pixel);
    const description = `![Screen](<${image}>)`;
    await service.upsert("codex", "completion-1", { title: "Done", description });
    const item = service.get("codex", "completion-1")!;
    const questions = async () => [];
    const response = await attentionFileResponse(item, image, false, questions, true);
    expect(response.headers["Content-Type"]).toBe("image/png");
    expect(response.headers["Content-Disposition"]).toBe("inline");
    expect(response.body).toEqual(pixel);
    await expect(attentionFileResponse(item, other, false, questions, true)).rejects.toMatchObject({ status: 403 });
    await expect(attentionFileResponse(item, image, false, questions)).rejects.toMatchObject({ status: 403 });
    const impostor = path.join(directory, "impostor.png"); await fs.writeFile(impostor, "not an image");
    await service.upsert("codex", "completion-2", { title: "Done", description: `![Fake](<${impostor}>)` });
    await expect(attentionFileResponse(service.get("codex", "completion-2")!, impostor, false, questions, true))
      .rejects.toMatchObject({ status: 415 });
  } finally {
    service.close();
  }
});
