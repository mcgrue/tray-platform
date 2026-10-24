import "./index.css";
import { mountAttentionUI } from "../app/attention-ui";
import { WebAttentionBridge } from "./web-attention-bridge";
import { mountWebHeader } from "./header-ui";

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let online = false, refreshing = false, requestRevision = 0;
const header = mountWebHeader();
const bridge = new WebAttentionBridge(value => {
  online = value;
  header.connection(value, value ? "Connected to your desktop" : "Disconnected — showing the last view. Check Tailscale and that your desktop is awake.");
}, () => { byId("delivery").hidden = !bridge.pendingCount; });
byId("delivery").hidden = !bridge.pendingCount;
const requestedItem = () => {
  try {
    const value = JSON.parse(new URLSearchParams(location.hash.slice(1)).get("item") || "null");
    return Array.isArray(value) && value.length === 2 && value.every(part => typeof part === "string") ? { source: value[0], id: value[1] } : undefined;
  } catch { return undefined; }
};
const dispose = mountAttentionUI(document.querySelector("main")!, bridge, { navigation: "phone", requestedItem, requestRevision: () => requestRevision });
async function reconnect() {
  if (refreshing) return;
  refreshing = true;
  try { await bridge.connect(); } finally { refreshing = false; }
}
byId("refresh").onclick = () => { void reconnect(); };
window.addEventListener("online", reconnect);
window.addEventListener("offline", () => { header.connection(false, "Offline — reconnect to send changes."); online = false; });
window.addEventListener("hashchange", () => { requestRevision++; void reconnect(); });
navigator.serviceWorker?.addEventListener("message", event => {
  if (event.data?.type !== "attention-open" || typeof event.data.url !== "string") return;
  const target = new URL(event.data.url, location.origin);
  if (target.origin !== location.origin || target.pathname !== "/") return;
  location.hash = target.hash; requestRevision++; void reconnect();
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) void reconnect(); });
const retry = setInterval(() => { if (!document.hidden && !online) void reconnect(); }, 10000);
window.addEventListener("beforeunload", () => { clearInterval(retry); dispose(); header.dispose(); bridge.close(); });
byId("check-delivery").onclick = async () => {
  try { await bridge.checkDeliveries(); byId("delivery-status").textContent = bridge.pendingCount ? "Still unconfirmed. Check the Codex conversation before sending again." : "Delivery confirmed. Refresh the question if needed."; }
  catch (error) { byId("delivery-status").textContent = (error as Error).message; }
};
byId("reset-delivery").onclick = () => {
  if (confirm("Only continue after checking the Codex conversation. Allowing another send may duplicate an instruction that already arrived.")) bridge.allowAnotherSend();
};

let registration: ServiceWorkerRegistration | undefined;
const pushStatus = (message: string) => { byId("push-status").textContent = message; };
async function updatePushButtons() {
  const subscription = await registration?.pushManager.getSubscription();
  byId("enable-push").hidden = Boolean(subscription);
  byId("test-push").hidden = byId("disable-push").hidden = !subscription;
  return subscription;
}
byId("enable-push").onclick = async () => {
  const button = byId<HTMLButtonElement>("enable-push"); button.disabled = true;
  try {
    if (!registration || !("PushManager" in window)) throw new Error("Background notifications are unavailable. Use an updated Firefox or Chrome on Android, in a normal browsing window.");
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Notifications are blocked. Allow them in this site's browser settings and Android notification settings.");
    const { publicKey } = await bridge.request("/api/push/public-key");
    const key = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    const subscription = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await bridge.request("/api/push/subscriptions", { subscription: subscription.toJSON() });
    await updatePushButtons(); pushStatus("Notifications enabled on this phone.");
  } catch (error) { pushStatus((error as Error).message); } finally { button.disabled = false; }
};
byId("disable-push").onclick = async () => {
  try {
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) {
      await bridge.request("/api/push/unsubscribe", { endpoint: subscription.endpoint });
      await subscription.unsubscribe();
    }
    await updatePushButtons(); pushStatus("Notifications disabled on this phone.");
  } catch (error) { pushStatus((error as Error).message); }
};
byId("test-push").onclick = async () => {
  const button = byId<HTMLButtonElement>("test-push"); button.disabled = true;
  try {
    const subscription = await registration?.pushManager.getSubscription();
    await bridge.request("/api/push/test", { endpoint: subscription?.endpoint }); pushStatus("Test notification sent.");
  } catch (error) { pushStatus((error as Error).message); } finally { button.disabled = false; }
};
void (async () => {
  await reconnect();
  if (!("serviceWorker" in navigator)) { pushStatus("This browser does not support background notifications."); return; }
  try {
    await navigator.serviceWorker.register("/sw.js"); registration = await navigator.serviceWorker.ready;
    if (!("pushManager" in registration)) { pushStatus("Background notifications are unavailable in this browser. Try an updated Firefox or Chrome on Android."); return; }
    const subscription = await updatePushButtons();
    if (subscription) { await bridge.request("/api/push/subscriptions", { subscription: subscription.toJSON() }); pushStatus("Notifications enabled on this phone."); }
  } catch (error) { pushStatus(`Notification setup: ${(error as Error).message}`); byId("enable-push").hidden = false; }
})();
