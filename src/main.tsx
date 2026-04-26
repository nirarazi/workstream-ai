import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./index.css";

// Diagnostic: catch unhandled errors and promise rejections
window.addEventListener("error", (e) => {
  console.error("[GLOBAL ERROR]", e.error ?? e.message);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("[UNHANDLED REJECTION]", e.reason);
});

// Restore theme preference
if (localStorage.getItem("workstream-theme") === "light") {
  document.documentElement.classList.add("light");
}

// Restore text size preference
const savedSize = localStorage.getItem("workstream-text-size");
if (savedSize === "small") document.documentElement.style.zoom = "0.88";
else if (savedSize === "large") document.documentElement.style.zoom = "1.12";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
