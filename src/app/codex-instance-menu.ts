import { CodexInstance } from "../shared/codex-instances";

let nextMenuId = 0;

export function mountCodexInstanceMenu(root: HTMLElement, onMessage: (instance: CodexInstance) => void) {
  const menu = document.createElement("div");
  menu.id = `codex-instance-menu-${++nextMenuId}`;
  menu.dataset.instanceMenu = ""; menu.hidden = true; menu.setAttribute("role", "menu");
  const message = document.createElement("button");
  message.type = "button"; message.textContent = "Message"; message.dataset.messageCodex = "";
  message.setAttribute("role", "menuitem"); message.tabIndex = -1;
  menu.appendChild(message); root.appendChild(menu);
  let active: { instance: CodexInstance; trigger: HTMLButtonElement } | undefined;

  function close(restoreFocus = false) {
    const trigger = active?.trigger;
    active = undefined; menu.hidden = true;
    trigger?.setAttribute("aria-expanded", "false");
    if (restoreFocus && trigger?.isConnected) trigger.focus();
  }
  function position() {
    if (!active) return;
    if (!active.trigger.isConnected || !active.trigger.getClientRects().length) { close(); return; }
    const anchor = active.trigger.getBoundingClientRect();
    const width = document.documentElement.clientWidth, height = document.documentElement.clientHeight;
    if (anchor.bottom <= 0 || anchor.top >= height) { close(); return; }
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(anchor.right - bounds.width, width - bounds.width - 8))}px`;
    const top = anchor.bottom + 4 + bounds.height <= height - 8 ? anchor.bottom + 4 : anchor.top - bounds.height - 4;
    menu.style.top = `${Math.max(8, top)}px`;
  }
  function open(instance: CodexInstance, trigger: HTMLButtonElement) {
    if (trigger.matches(":disabled")) return;
    close(); active = { instance, trigger };
    menu.setAttribute("aria-label", trigger.getAttribute("aria-label")!);
    trigger.setAttribute("aria-expanded", "true"); menu.hidden = false;
    position(); if (active) message.focus();
  }
  message.addEventListener("click", () => {
    if (!active || message.matches(":disabled")) return;
    const instance = active.instance;
    close(); onMessage(instance);
  });
  const outside = (event: Event) => {
    if (active && !menu.contains(event.target as Node) && !active.trigger.contains(event.target as Node)) close();
  };
  const keyboard = (event: KeyboardEvent) => {
    if (!active) return;
    if (event.key === "Escape") { event.preventDefault(); close(true); }
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && menu.contains(event.target as Node)) {
      event.preventDefault(); message.focus();
    }
  };
  document.addEventListener("pointerdown", outside);
  document.addEventListener("focusin", outside);
  document.addEventListener("keydown", keyboard);
  document.addEventListener("scroll", position, true);
  window.addEventListener("resize", position);
  return {
    trigger(instance: CodexInstance) {
      const button = document.createElement("button");
      button.type = "button"; button.dataset.instanceMenuToggle = "";
      button.setAttribute("aria-label", `More options for ${instance.title || instance.workspace || "Codex"} (PID ${instance.codexPid})`);
      button.setAttribute("aria-haspopup", "menu"); button.setAttribute("aria-controls", menu.id);
      button.setAttribute("aria-expanded", "false"); button.title = "More options";
      button.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
      button.addEventListener("click", () => { if (active?.trigger === button) close(true); else open(instance, button); });
      button.addEventListener("keydown", event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); open(instance, button); }
      });
      // Activity snapshots rebuild rows; retain the open menu for the same process identity.
      if (active?.instance.codexPid === instance.codexPid && active.instance.codexStartedAt === instance.codexStartedAt) {
        active = { instance, trigger: button }; button.setAttribute("aria-expanded", "true");
        menu.setAttribute("aria-label", button.getAttribute("aria-label")!);
      }
      return button;
    },
    update() {
      if (active && !active.trigger.isConnected && menu.contains(document.activeElement)) root.querySelector<HTMLButtonElement>("button")?.focus();
      position();
    },
    dispose() {
      close(); menu.remove();
      document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", keyboard); document.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
    },
  };
}
