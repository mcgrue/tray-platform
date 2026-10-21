export interface TitlebarState {
  title: string;
  color: string;
  textColor: string;
  focused: boolean;
  maximized: boolean;
  platform: string;
}

export type TitlebarAction = "minimize" | "maximize" | "close";

export interface TitlebarBridge {
  getTitlebar(): Promise<TitlebarState>;
  onTitlebarChanged(callback: (state: TitlebarState) => void): () => void;
  titlebarAction(action: TitlebarAction): void;
}
