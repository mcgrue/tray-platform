let toast: HTMLDivElement | undefined, message: HTMLParagraphElement, timer: number | undefined;
const pause = () => { window.clearTimeout(timer); };
const dismiss = () => { pause(); if (toast) toast.hidden = true; };
const scheduleDismiss = () => {
  pause();
  if (toast && !toast.matches(":hover") && !toast.contains(document.activeElement)) timer = window.setTimeout(dismiss, 8000);
};

/** One visible toast per pane; repeated warnings replace it and restart the timer. */
export function showToast(text: string) {
  if (!toast) {
    toast = document.createElement("div"); toast.dataset.toast = "";
    toast.setAttribute("role", "alert"); toast.setAttribute("aria-atomic", "true");
    message = document.createElement("p");
    const close = document.createElement("button"); close.type = "button"; close.textContent = "×";
    close.title = "Dismiss notification"; close.setAttribute("aria-label", close.title); close.onclick = dismiss;
    toast.append(message, close); document.body.appendChild(toast);
    toast.addEventListener("pointerenter", pause); toast.addEventListener("pointerleave", scheduleDismiss);
    toast.addEventListener("focusin", pause); toast.addEventListener("focusout", scheduleDismiss);
  }
  toast.hidden = false; message.textContent = "";
  window.setTimeout(() => { message.textContent = text; }, 0);
  scheduleDismiss();
}
