import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { CustomerDisplay } from "./views/Devices.jsx";
import "./index.css";

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("BladeOS crashed:", error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#F7F3EC", fontFamily: "Inter, sans-serif", padding: 24 }}>
          <div style={{ maxWidth: 420, textAlign: "center" }}>
            <h1 style={{ fontFamily: "Fraunces, serif", color: "#221C17", fontSize: 24, marginBottom: 8 }}>Something went wrong</h1>
            <p style={{ color: "#8A8175", fontSize: 14, marginBottom: 20 }}>BladeOS hit an unexpected error. Reloading usually fixes it.</p>
            <button onClick={() => window.location.reload()} style={{ background: "#7A2331", color: "#fff", border: 0, borderRadius: 8, padding: "10px 18px", fontWeight: 600, cursor: "pointer" }}>
              Reload BladeOS
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// Installable app + offline: register the service worker (production builds only).
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then((reg) => {
      const ready = (w) => {
        // A new version is installed and waiting. It's applied on its own as soon as nobody is mid-task
        // (no ticket on the till, no dialog open, not typing) — an old copy never lingers. The banner offers it too.
        window.__bladeosUpdate = () => { w.postMessage("skipWaiting"); };
        window.dispatchEvent(new Event("bladeos-update"));
        const idle = () => !window.__bladeosBusy && !document.querySelector("[role=dialog]")
          && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName || "");
        const tryApply = () => { if (idle()) w.postMessage("skipWaiting"); else setTimeout(tryApply, 15000); };
        setTimeout(tryApply, 1500);
      };
      if (reg.waiting && navigator.serviceWorker.controller) ready(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        w?.addEventListener("statechange", () => { if (w.state === "installed" && navigator.serviceWorker.controller) ready(w); });
      });
      setInterval(() => reg.update().catch(() => {}), 30 * 60e3);
    }).catch((e) => console.warn("Service worker not registered:", e.message));
    // Reload only when a new version takes over a page an older one was running — never on the very first visit,
    // which would wipe whatever the person had started typing on the sign-in form.
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController && !reloading) { reloading = true; window.location.reload(); } });
  });
}
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  window.__bladeosInstall = async () => { e.prompt(); await e.userChoice.catch(() => {}); window.__bladeosInstall = null; window.dispatchEvent(new Event("bladeos-installable")); };
  window.dispatchEvent(new Event("bladeos-installable"));
});

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      {/* The terminal's customer-facing screen: no sign-in, shows only what the till in this browser sends it. */}
      {window.location.hash === "#customer-display" ? <CustomerDisplay /> : <App />}
    </ErrorBoundary>
  </React.StrictMode>
);
