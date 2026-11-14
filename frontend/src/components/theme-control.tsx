import { useEffect, useRef, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";

type ThemeMode = "light" | "dark" | "system";
const preferenceKey = "knovid.theme.v1";
const labels = { light: "浅色模式", dark: "夜间模式", system: "跟随系统" };
const isMode = (value: unknown): value is ThemeMode =>
  ["light", "dark", "system"].includes(String(value));

function readPreference(): ThemeMode {
  try {
    const saved = localStorage.getItem(preferenceKey);
    return isMode(saved) ? saved : "system";
  } catch {
    return "system";
  }
}

export function ThemeControl() {
  const trigger = useRef<HTMLButtonElement>(null);
  const [mode, setMode] = useState<ThemeMode>(readPreference);
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );

  useEffect(() => {
    const system = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const isDark = mode === "dark" || (mode === "system" && system.matches);
      const root = document.documentElement;
      root.classList.toggle("dark", isDark);
      root.dataset.theme = isDark ? "dark" : "light";
      root.style.colorScheme = isDark ? "dark" : "light";
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", isDark ? "#0d1121" : "#f7f8fc");
      setDark(isDark);
    };
    apply();
    system.addEventListener("change", apply);
    return () => system.removeEventListener("change", apply);
  }, [mode]);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === preferenceKey || event.key === null)
        setMode(readPreference());
    };
    window.addEventListener("storage", sync);
    const syncLocal = (event: Event) => {
      const value = (event as CustomEvent<ThemeMode>).detail;
      if (isMode(value)) setMode(value);
    };
    window.addEventListener("knovid:theme-changed", syncLocal);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("knovid:theme-changed", syncLocal);
    };
  }, []);

  function change(value: string) {
    if (!isMode(value)) return;
    setMode(value);
    window.dispatchEvent(
      new CustomEvent("knovid:theme-changed", { detail: value }),
    );
    try {
      localStorage.setItem(preferenceKey, value);
    } catch {
      /* Keep the current choice in memory. */
    }
  }

  return (
    <Select value={mode} onValueChange={change}>
      <SelectTrigger
        ref={trigger}
        className="theme-control"
        aria-label={`切换外观，当前${labels[mode]}`}
        title={labels[mode]}
      >
        {dark ? <Moon size={15} /> : <Sun size={15} />}
        <span className="theme-control-label">{labels[mode]}</span>
      </SelectTrigger>
      <SelectContent
        position="popper"
        align="end"
        sideOffset={8}
        className="theme-menu"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          trigger.current?.focus({ preventScroll: true });
        }}
      >
        <SelectItem value="light">
          <Sun size={15} />
          浅色模式
        </SelectItem>
        <SelectItem value="dark">
          <Moon size={15} />
          夜间模式
        </SelectItem>
        <SelectItem value="system">
          <Monitor size={15} />
          跟随系统
        </SelectItem>
      </SelectContent>
    </Select>
  );
}
