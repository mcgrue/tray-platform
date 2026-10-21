import { TitlebarBridge, TitlebarState } from "../shared/titlebar";

export function mountTitlebar(root: HTMLElement, bridge: TitlebarBridge): () => void {
  const label = root.querySelector<HTMLElement>("[data-titlebar-label]")!;
  const controls = root.querySelector<HTMLElement>("[data-titlebar-controls]")!;
  const maximize = controls.querySelector<HTMLButtonElement>('[data-window-action="maximize"]')!;
  let disposed = false, revision = 0;
  const render = (state: TitlebarState) => {
    if (disposed) return;
    root.dataset.platform = state.platform;
    root.dataset.focused = String(state.focused);
    root.style.backgroundColor = state.color;
    root.style.color = state.textColor;
    label.textContent = state.title;
    controls.hidden = state.platform === "win32" || state.platform === "darwin";
    maximize.textContent = state.maximized ? "❐" : "□";
    maximize.setAttribute("aria-label", state.maximized ? "Restore window" : "Maximize window");
  };
  const click = (event: MouseEvent) => {
    const action = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-window-action]")?.dataset.windowAction;
    if (action === "minimize" || action === "maximize" || action === "close") bridge.titlebarAction(action);
  };
  controls.addEventListener("click", click);
  const unsubscribe = bridge.onTitlebarChanged(state => { revision++; render(state); });
  const initialRevision = revision;
  void bridge.getTitlebar().then(state => { if (initialRevision === revision) render(state); }).catch(console.error);
  return () => { disposed = true; unsubscribe(); controls.removeEventListener("click", click); };
}
