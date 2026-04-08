import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Restore theme preference
if (localStorage.getItem("atc-theme") === "light") {
  document.documentElement.classList.add("light");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
