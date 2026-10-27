interface MessageInputOptions { phone?: boolean; label: string; placeholder: string; rows: number; maxLength: number; }
interface MessageInput { element: HTMLElement; value: string; disabled: boolean; focus(): void; insertNewline(): void; dispose(): void; }

/** Serialize editing blocks without counting the browser's caret-placeholder BR. */
export function readCodexMessageText(element: HTMLElement): string {
  if (element instanceof HTMLTextAreaElement) return element.value;
  const read = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
    if (node.nodeName === "BR") return node.nextSibling ? "\n" : "";
    let previousBlock = false;
    return Array.from(node.childNodes).map((child, index) => {
      const block = child.nodeName === "DIV" || child.nodeName === "P";
      const separator = index > 0 && (block || previousBlock) ? "\n" : "";
      previousBlock = block;
      return separator + read(child);
    }).join("");
  };
  return read(element).replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
}

/** A rich editing host advertises image input to Android keyboards. Messages stay plain text. */
export function createCodexMessageInput(options: MessageInputOptions): MessageInput {
  const element = options.phone ? document.createElement("div") : document.createElement("textarea");
  element.dataset.messageInput = "";
  element.setAttribute("aria-label", options.label);
  if (element instanceof HTMLTextAreaElement) {
    element.rows = options.rows; element.maxLength = options.maxLength; element.placeholder = options.placeholder;
    return { element, get value() { return element.value; }, set value(value: string) { element.value = value; },
      get disabled() { return element.disabled; }, set disabled(value: boolean) { element.disabled = value; }, focus: () => element.focus(),
      insertNewline() {
        if (element.matches(":disabled") || element.value.length - (element.selectionEnd - element.selectionStart) >= options.maxLength) return;
        element.focus();
        if (!document.execCommand("insertText", false, "\n")) {
          element.setRangeText("\n", element.selectionStart, element.selectionEnd, "end");
          element.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }, dispose() {} };
  }

  element.dataset.mobileMessageInput = "";
  element.dataset.placeholder = options.placeholder;
  element.style.minHeight = `calc(${options.rows * 1.5}em + 18px)`;
  element.setAttribute("role", "textbox"); element.setAttribute("aria-multiline", "true");
  element.setAttribute("aria-placeholder", options.placeholder);
  element.setAttribute("inputmode", "text"); element.setAttribute("enterkeyhint", "enter");
  element.setAttribute("autocapitalize", "sentences"); element.spellcheck = true;
  let value = "", disabled = false, disposed = false, composing = false;
  const blocked = () => disabled || !!element.closest("fieldset:disabled");
  const refreshDisabled = () => {
    const unavailable = blocked();
    const editable = unavailable ? "false" : "true";
    if (element.contentEditable !== editable) element.contentEditable = editable;
    element.setAttribute("aria-disabled", String(unavailable)); element.tabIndex = unavailable ? -1 : 0;
  };
  const observer = new MutationObserver(refreshDisabled);
  const observeAvailability = () => {
    observer.disconnect();
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (parent instanceof HTMLFieldSetElement) observer.observe(parent, { attributes: true, attributeFilter: ["disabled"] });
    }
    refreshDisabled();
  };
  // Composers are initially constructed before their card is attached to the page.
  queueMicrotask(() => { if (!disposed) observeAvailability(); });
  const setValue = (next: string) => {
    value = next; element.textContent = next; element.dataset.empty = String(!next);
  };
  const readValue = () => readCodexMessageText(element);
  const updateValue = () => {
    // A lone browser-generated BR is the empty editing host, not a typed newline.
    value = element.innerHTML === "<br>" ? "" : readValue();
    if (!composing && value.length > options.maxLength) {
      setValue(value.slice(0, options.maxLength));
      const range = document.createRange(); range.selectNodeContents(element); range.collapse(false);
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    }
    element.dataset.empty = String(!value);
  };
  const selectedLength = () => {
    const selection = window.getSelection();
    return selection?.rangeCount && element.contains(selection.anchorNode) && element.contains(selection.focusNode) ? selection.toString().length : 0;
  };
  const insertText = (text: string) => {
    if (blocked()) return;
    const available = Math.max(0, options.maxLength - value.length + selectedLength());
    // insertText preserves the browser's selection and undo history without inserting HTML.
    document.execCommand("insertText", false, text.slice(0, available));
  };
  element.addEventListener("beforeinput", event => {
    const input = event as InputEvent;
    if (blocked() || input.inputType.startsWith("format")) { event.preventDefault(); return; }
    if (!input.isComposing && input.inputType.startsWith("insert") && input.data &&
      value.length - selectedLength() + input.data.length > options.maxLength) event.preventDefault();
  });
  element.addEventListener("paste", event => {
    if (blocked()) { event.preventDefault(); return; }
    // Image paste bubbles to the existing attachment handler on the form.
    if (Array.from(event.clipboardData?.items || []).some(item => item.kind === "file" && item.type.startsWith("image/"))) return;
    event.preventDefault(); insertText(event.clipboardData?.getData("text/plain") || "");
  });
  element.addEventListener("drop", event => {
    if (event.dataTransfer?.files.length) return; // The form handles file attachments.
    event.preventDefault(); insertText(event.dataTransfer?.getData("text/plain") || "");
  });
  element.addEventListener("input", updateValue);
  element.addEventListener("compositionstart", () => { composing = true; });
  element.addEventListener("compositionend", () => {
    composing = false; updateValue(); element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  setValue(""); refreshDisabled();
  return { element, get value() { return value; }, set value(next: string) { if (next !== value) setValue(next); },
    get disabled() { return blocked(); }, set disabled(next: boolean) { disabled = next; observeAvailability(); },
    focus: () => { if (!blocked()) element.focus(); }, insertNewline: () => insertText("\n"),
    dispose() { disposed = true; observer.disconnect(); } };
}
