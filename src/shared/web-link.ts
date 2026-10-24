/** Only absolute web URLs may leave the attention pane. */
export function isWebLink(value: string): boolean {
  if (!/^https?:\/\//i.test(value) || /[\u0000-\u0020\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch { return false; }
}
