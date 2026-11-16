import { memo } from "react";
import type { ThemeSetting } from "../store/settingsSlice";

export interface ThemeToggleProps {
  value: ThemeSetting;
  onChange: (theme: ThemeSetting) => void;
}

const NEXT: Record<ThemeSetting, ThemeSetting> = { system: "light", light: "dark", dark: "system" };
const LABEL: Record<ThemeSetting, string> = { system: "Auto", light: "Light", dark: "Dark" };
const ICON: Record<ThemeSetting, string> = { system: "◐", light: "☀", dark: "☾" };

/** Cycles Auto → Light → Dark. Auto follows the operating system. */
export const ThemeToggle = memo(function ThemeToggle({ value, onChange }: ThemeToggleProps) {
  return (
    <button
      type="button"
      className="button button--ghost"
      onClick={() => {
        onChange(NEXT[value]);
      }}
      aria-label={`Theme: ${LABEL[value]}. Switch to ${LABEL[NEXT[value]]}`}
    >
      <span aria-hidden="true">{ICON[value]}</span> {LABEL[value]}
    </button>
  );
});
