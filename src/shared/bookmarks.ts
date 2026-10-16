import { Destination, NavigationBridge, WindowDestination } from "./attention";

export interface BookmarkInput {
  title: string;
  project?: string;
  attention?: { source: string; id: string };
  humanNote?: string;
  robotHint?: string;
  destination?: Destination;
}
export interface Bookmark extends BookmarkInput {
  source: string;
  id: string;
  createdAt: number;
  updatedAt: number;
}
export interface BookmarkSnapshot {
  bookmarks: Bookmark[];
  error?: string;
}
export interface BookmarkCapture {
  destination?: WindowDestination;
  error?: string;
}
export interface BookmarkBridge extends NavigationBridge {
  getBookmarks(): Promise<BookmarkSnapshot>;
  saveBookmark(source: string, id: string, input: BookmarkInput): Promise<void>;
  goToBookmark(source: string, id: string): Promise<void>;
  captureBookmark(): Promise<void>;
  onBookmarksChanged(callback: (snapshot: BookmarkSnapshot) => void): () => void;
  onCaptureBookmark(callback: (capture: BookmarkCapture) => void): () => void;
}
