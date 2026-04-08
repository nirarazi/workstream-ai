import { useState, useEffect, useCallback } from "react";

export type ThemeMode = "dark" | "light" | "system";

const STORAGE_KEY = "atc-theme";

function getSystemTheme(): "dark" | "light" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(resolved: "dark" | "light") {
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.classList.toggle("light", resolved === "light");
}

export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    return (localStorage.getItem(STORAGE_KEY) as ThemeMode) || "dark";
  });

  const resolved = mode === "system" ? getSystemTheme() : mode;

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    localStorage.setItem(STORAGE_KEY, m);
  }, []);

  // Cycle: dark → light → system → dark
  const cycle = useCallback(() => {
    setMode(mode === "dark" ? "light" : mode === "light" ? "system" : "dark");
  }, [mode, setMode]);

  // Apply on mount and when mode changes
  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  // Listen for system theme changes when in system mode
  useEffect(() => {
    if (mode !== "system") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme(getSystemTheme());
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [mode]);

  return { mode, resolved, setMode, cycle };
}
