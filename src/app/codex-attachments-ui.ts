import { CodexAttachment, CodexAttachmentsBridge, CodexMessageDraft, MAX_CODEX_ATTACHMENTS, MAX_CODEX_ATTACHMENT_BYTES, MAX_CODEX_ATTACHMENTS_BYTES } from "../shared/codex-attachments";
import { showToast } from "./toast";

interface DraftFile { id: string; file: File; preview?: string; uploaded?: CodexAttachment; error?: string; uploading?: boolean; }
export interface AttachmentDraft { files: DraftFile[]; }
export const newAttachmentDraft = (): AttachmentDraft => ({ files: [] });
export function attachmentMessage(text: string, draft: AttachmentDraft): CodexMessageDraft {
  return draft.files.length ? { text, attachmentIds: draft.files.map(file => file.id) } : text;
}
const read = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(new Error(`Cannot read ${file.name}. Choose the file again.`)); reader.readAsDataURL(file);
});
const imageMime = (file: File) => /^image\/(png|jpeg|webp|gif)$/.test(file.type) ? file.type
  : ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" } as Record<string, string>)[file.name.split(".").pop()?.toLowerCase() || ""];
const sizeLabel = (size: number) => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KiB` : `${(size / 1024 / 1024).toFixed(1)} MiB`;
const attachmentIcon = (image: boolean) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${image
  ? '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m21 15-5-5L5 21"/>'
  : '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>'}</svg>`;
const textPreview = (file: File) => file.type.startsWith("text/") || /^(application\/(json|xml|javascript))$/.test(file.type)
  || /\.(txt|md|json|jsonl|csv|tsv|log|js|jsx|ts|tsx|css|html|xml|svg|yaml|yml|toml|ini|sh|ps1|py|c|h|cpp|hpp|rs|go)$/i.test(file.name);
const attachmentStatus = (entry: DraftFile) => entry.uploading ? "Uploading…" : entry.error || (entry.uploaded ? "Ready to send" : "Attached");

/** Draft state belongs to the composer, so switching instances cannot move files between drafts. */
export function mountCodexAttachmentsUI(root: HTMLElement, form: HTMLFormElement, bridge: CodexAttachmentsBridge,
  current: () => AttachmentDraft | undefined, changed: () => void) {
  let disabled = false, disposed = false;
  root.dataset.codexAttachments = "";
  const picker = document.createElement("input"); picker.type = "file"; picker.multiple = true; picker.hidden = true;
  picker.setAttribute("aria-label", "Choose files and images");
  const choose = document.createElement("button"); choose.type = "button"; choose.dataset.attachFiles = "";
  choose.title = "Attach files or images"; choose.setAttribute("aria-label", choose.title);
  choose.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
  const list = document.createElement("ul");
  list.setAttribute("aria-label", "Attachments");
  root.append(picker, list);
  const blocked = () => disabled || choose.matches(":disabled") || !bridge.uploadCodexAttachment;
  const preview = document.createElement("dialog"); preview.dataset.attachmentPreview = "";
  const content = document.createElement("div"); content.dataset.attachmentContent = "";
  const metadata = document.createElement("div"); metadata.dataset.attachmentMetadata = "";
  const filename = document.createElement("strong"), size = document.createElement("span"), previewStatus = document.createElement("span");
  previewStatus.setAttribute("role", "status"); metadata.append(filename, size, previewStatus);
  const back = document.createElement("button"); back.type = "button"; back.dataset.attachmentBack = "";
  back.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="m6 6 12 12M18 6 6 18"/></svg>';
  back.title = "Close preview"; back.setAttribute("aria-label", back.title);
  const remove = document.createElement("button"); remove.type = "button"; remove.dataset.attachmentRemove = "";
  remove.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/></svg>';
  preview.append(content, metadata, back, remove);
  let selected: { draft: AttachmentDraft; entry: DraftFile } | undefined, previewImage: HTMLImageElement | undefined;
  const availabilityObserver = new MutationObserver(() => { if (selected) remove.disabled = blocked(); });

  function closePreview(restoreFocus = true) {
    const id = selected?.entry.id;
    availabilityObserver.disconnect();
    selected = undefined; previewImage = undefined;
    if (preview.open) preview.close();
    preview.remove(); content.replaceChildren();
    if (restoreFocus && !disposed) {
      const button = Array.from(list.querySelectorAll<HTMLButtonElement>("[data-attachment-open]"))
        .find(button => button.closest<HTMLElement>("li")?.dataset.attachmentId === id);
      (button || choose).focus();
    }
  }
  function refreshPreview() {
    if (!selected) return;
    if (current() !== selected.draft || !selected.draft.files.includes(selected.entry)) { closePreview(false); return; }
    const { entry } = selected;
    remove.disabled = blocked(); previewStatus.textContent = attachmentStatus(entry);
    if (previewImage && entry.preview && previewImage.getAttribute("src") !== entry.preview) previewImage.src = entry.preview;
  }
  function openPreview(draft: AttachmentDraft, entry: DraftFile) {
    if (disposed) return;
    closePreview(false); selected = { draft, entry }; content.dataset.attachmentContent = "";
    const selection = selected;
    preview.setAttribute("aria-label", `Preview ${entry.file.name}`);
    filename.textContent = entry.file.name; size.textContent = sizeLabel(entry.file.size);
    remove.title = `Remove ${entry.file.name}`; remove.setAttribute("aria-label", remove.title);
    if (imageMime(entry.file)) {
      previewImage = document.createElement("img"); previewImage.alt = entry.file.name;
      previewImage.onerror = () => { if (selected === selection) content.textContent = "Image preview unavailable."; };
      content.append(previewImage);
    } else if (textPreview(entry.file)) {
      content.dataset.attachmentContent = "text";
      const text = document.createElement("pre"); text.tabIndex = 0; text.textContent = "Loading preview…"; content.append(text);
      // Keep source files inert and bound the amount of text rendered in the modal.
      void entry.file.slice(0, 64 * 1024).text().then(value => {
        if (selected === selection) text.textContent = value + (entry.file.size > 64 * 1024 ? "\n\nPreview truncated to 64 KiB." : "");
      }, () => { if (selected === selection) text.textContent = "File preview unavailable."; });
    } else {
      const icon = document.createElement("div"); icon.dataset.attachmentFile = ""; icon.innerHTML = attachmentIcon(false);
      const hint = document.createElement("p"); hint.textContent = "No preview available for this file type.";
      content.append(icon, hint);
    }
    // The modal lives outside the phone's fieldset, which changes during reconnects.
    for (let ancestor = choose.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor instanceof HTMLFieldSetElement) availabilityObserver.observe(ancestor, { attributes: true, attributeFilter: ["disabled"] });
    }
    refreshPreview(); document.body.append(preview); preview.showModal(); back.focus();
  }
  back.onclick = () => closePreview();
  preview.addEventListener("cancel", event => { event.preventDefault(); closePreview(); });
  preview.addEventListener("click", event => {
    const bounds = preview.getBoundingClientRect();
    if (event.target === preview && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) closePreview();
  });
  remove.onclick = () => {
    if (!selected || blocked() || current() !== selected.draft) return;
    const { draft, entry } = selected;
    draft.files = draft.files.filter(file => file !== entry); closePreview(false); changed(); choose.focus();
  };
  function refresh(value = disabled) {
    disabled = value; root.hidden = choose.hidden = !bridge.uploadCodexAttachment; choose.disabled = picker.disabled = disabled;
    const draft = current(); list.replaceChildren(); list.hidden = !draft?.files.length;
    for (const entry of draft?.files || []) {
      const row = document.createElement("li"); row.dataset.attachmentId = entry.id;
      const open = document.createElement("button"); open.type = "button"; open.dataset.attachmentOpen = "";
      open.dataset.attachmentKind = imageMime(entry.file) ? "image" : "file";
      open.title = `${entry.file.name} (${sizeLabel(entry.file.size)}) — ${attachmentStatus(entry)}`;
      open.setAttribute("aria-label", `Preview ${open.title}`); open.setAttribute("aria-haspopup", "dialog");
      open.innerHTML = attachmentIcon(!!imageMime(entry.file));
      if (imageMime(entry.file) && entry.preview) {
        const thumbnail = document.createElement("img"); thumbnail.alt = ""; thumbnail.draggable = false;
        thumbnail.onload = () => {
          open.dataset.attachmentThumbnail = ""; open.querySelector("svg")?.replaceWith(thumbnail);
        };
        // Keep the image icon as a fallback while loading or if decoding fails.
        thumbnail.src = entry.preview;
      }
      const status = document.createElement("span"); status.dataset.attachmentStatus = ""; status.setAttribute("role", "status");
      status.textContent = attachmentStatus(entry);
      if (entry.error || entry.uploading) {
        const badge = document.createElement("span"); badge.dataset.attachmentBadge = entry.error ? "error" : "uploading";
        badge.setAttribute("aria-hidden", "true"); badge.textContent = entry.error ? "!" : "…"; open.append(badge);
      }
      open.onclick = () => openPreview(draft!, entry);
      row.append(open, status); list.appendChild(row);
    }
    refreshPreview();
  }
  async function add(files: File[]) {
    const draft = current(); if (!draft || disposed || blocked() || !files.length) return;
    const total = [...draft.files.map(entry => entry.file), ...files].reduce((sum, file) => sum + file.size, 0);
    const problem = draft.files.length + files.length > MAX_CODEX_ATTACHMENTS ? "Too many attachments."
      : files.some(file => file.size > MAX_CODEX_ATTACHMENT_BYTES) ? "That file is too large."
      : total > MAX_CODEX_ATTACHMENTS_BYTES ? "Those files are too large together." : "";
    if (problem) {
      showToast(`${problem} Attach up to 5 files, 10 MiB each and 20 MiB total.`); return;
    }
    const entries = files.map(file => ({ id: crypto.randomUUID(), file } as DraftFile)); draft.files.push(...entries); changed();
    for (const entry of entries) if (imageMime(entry.file)) {
      try {
        const data = await read(entry.file);
        entry.preview = `data:${imageMime(entry.file)};base64,${data.slice(data.indexOf(",") + 1)}`;
      } catch (reason) { entry.error = (reason as Error).message; }
      if (!disposed) changed();
    }
  }
  choose.onclick = () => { if (!blocked()) picker.click(); };
  picker.onchange = () => { const files = Array.from(picker.files || []); picker.value = ""; void add(files); };
  const dragover = (event: DragEvent) => { if (event.dataTransfer?.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = blocked() ? "none" : "copy"; } };
  const drop = (event: DragEvent) => { if (event.dataTransfer?.files.length) { event.preventDefault(); void add(Array.from(event.dataTransfer.files)); } };
  const paste = (event: ClipboardEvent) => {
    const files = Array.from(event.clipboardData?.items || []).filter(item => item.kind === "file" && item.type.startsWith("image/")).map(item => item.getAsFile()).filter((file): file is File => !!file);
    if (files.length) { event.preventDefault(); void add(files); }
  };
  form.addEventListener("dragover", dragover); form.addEventListener("drop", drop); form.addEventListener("paste", paste);
  refresh();
  return { button: choose, refresh, async upload(draft: AttachmentDraft) {
    for (const entry of draft.files) {
      if (entry.uploaded) continue;
      if (!bridge.uploadCodexAttachment) throw new Error("Attachments are unavailable.");
      entry.uploading = true; entry.error = ""; if (!disposed) changed();
      try {
        const data = await read(entry.file);
        const uploaded = await bridge.uploadCodexAttachment({ id: entry.id, name: entry.file.name, mimeType: imageMime(entry.file) || entry.file.type,
          base64: data.slice(data.indexOf(",") + 1) });
        if (uploaded.id !== entry.id) throw new Error("Upload identity did not match. Choose the file again.");
        entry.uploaded = uploaded;
      } catch (reason) { entry.error = (reason as Error).message; throw reason; }
      finally { entry.uploading = false; if (!disposed) changed(); }
    }
  }, dispose() { disposed = true; closePreview(false); form.removeEventListener("dragover", dragover); form.removeEventListener("drop", drop); form.removeEventListener("paste", paste); } };
}
