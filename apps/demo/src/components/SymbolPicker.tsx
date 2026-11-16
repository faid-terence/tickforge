import { memo } from "react";
import { SYMBOLS, type DemoSymbol } from "../worker/protocol";

export interface SymbolPickerProps {
  value: DemoSymbol;
  onChange: (symbol: DemoSymbol) => void;
}

/** Segmented control. Switching subscribes to the new symbol, then unsubscribes the old one. */
export const SymbolPicker = memo(function SymbolPicker({ value, onChange }: SymbolPickerProps) {
  return (
    <div className="segmented" role="radiogroup" aria-label="Market">
      {SYMBOLS.map((s) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={s === value}
          className="segmented__option"
          onClick={() => {
            onChange(s);
          }}
        >
          {s.replace("-USD", "")}
        </button>
      ))}
    </div>
  );
});
