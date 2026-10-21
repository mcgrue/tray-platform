import { BookmarkBridge } from "./bookmarks";
import { TitlebarBridge } from "./titlebar";

export interface PlatformBridge extends BookmarkBridge, TitlebarBridge {
  setTitle(title: string): void;
  playSound(id: string): void;
  openSoundConfig(): void;
  isDevMode(): Promise<boolean>;
  onShowAlert(callback: (value: string) => void): () => void;
  onRefreshPage(callback: (value: string) => void): () => void;
  onPlaySound(callback: (value: string) => void): () => void;
  onSayWords(callback: (value: string) => void): () => void;
}

declare global {
  interface Window { ipcComms: PlatformBridge; }
}
