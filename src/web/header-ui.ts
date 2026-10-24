export function mountWebHeader() {
  const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const toggle = byId<HTMLButtonElement>("menu-toggle"), menu = byId("header-menu");
  const refreshItem = byId<HTMLButtonElement>("refresh");
  const dialog = byId<HTMLDialogElement>("notifications-dialog"), notificationItem = byId<HTMLButtonElement>("open-notifications");
  function setMenu(open: boolean) {
    menu.hidden = !open; toggle.setAttribute("aria-expanded", String(open));
    if (open) refreshItem.focus();
  }
  toggle.onclick = () => setMenu(menu.hidden);
  const refresh = () => { setMenu(false); toggle.focus(); };
  refreshItem.addEventListener("click", refresh);
  notificationItem.onclick = () => { setMenu(false); dialog.showModal(); };
  byId("close-notifications").onclick = () => dialog.close();
  dialog.addEventListener("close", () => toggle.focus());
  dialog.addEventListener("click", event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
  const outside = (event: PointerEvent) => { if (!(event.target as Element).closest(".web-menu")) setMenu(false); };
  const keyboard = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !menu.hidden) { event.preventDefault(); setMenu(false); toggle.focus(); }
  };
  const focus = (event: FocusEvent) => { if (!(event.target as Element).closest(".web-menu")) setMenu(false); };
  document.addEventListener("pointerdown", outside);
  document.addEventListener("keydown", keyboard);
  document.addEventListener("focusin", focus);
  return {
    connection(connected: boolean, message: string) {
      const indicator = byId("connection");
      indicator.dataset.connected = String(connected); indicator.title = message;
      indicator.querySelector(".visually-hidden")!.textContent = message;
      byId<HTMLFieldSetElement>("online-controls").disabled = !connected;
      byId<HTMLFieldSetElement>("notification-controls").disabled = !connected;
      byId("notification-offline").hidden = connected;
    },
    dispose() {
      refreshItem.removeEventListener("click", refresh);
      document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", keyboard); document.removeEventListener("focusin", focus);
    },
  };
}
