import { useEffect, useId, useRef, useState } from 'react';

export interface DropdownOption {
  value: string;
  label: string;
}

/**
 * Custom dropdown (no native <select>). Expands inline so it can never be
 * clipped by the scrollable filter sheet, and works identically with touch,
 * mouse and keyboard:
 * - Enter/Space/ArrowDown on the trigger opens and highlights the selection
 * - Arrows move, Enter/Space picks, Escape closes and refocuses the trigger
 * - tapping outside closes
 */
export function Dropdown({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(() => Math.max(0, options.findIndex((o) => o.value === value)));
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const baseId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const labelId = `${baseId}-label`;
  const listId = `${baseId}-list`;

  const selected = options.find((o) => o.value === value) ?? options[0];
  useEffect(() => {
    if (!open) return;
    setHighlight(Math.max(0, options.findIndex((o) => o.value === value)));
    const onPointerDown = (e: Event) => {
      const root = document.getElementById(`${baseId}-root`);
      if (root && !root.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown, { passive: true });
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
    };
  }, [open, baseId, options, value]);

  const pick = (next: string) => {
    onChange(next);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight(Math.max(0, options.findIndex((o) => o.value === value)));
      setOpen(true);
      requestAnimationFrame(() => {
        const idx = Math.max(0, options.findIndex((o) => o.value === value));
        optionRefs.current[idx]?.focus();
      });
    }
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = (highlight + 1) % options.length;
      setHighlight(next);
      optionRefs.current[next]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = (highlight - 1 + options.length) % options.length;
      setHighlight(next);
      optionRefs.current[next]?.focus();
    }
  };

  return (
    <div className="dd" id={`${baseId}-root`}>
      <span className="dd-label" id={labelId}>
        {label}
      </span>
      <button
        ref={triggerRef}
        type="button"
        className="dd-trigger"
        aria-label={`${label}: ${selected?.label ?? ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKey}
      >
        <span className="dd-value">{selected?.label ?? ''}</span>
        <span className={`dd-caret${open ? ' is-open' : ''}`} aria-hidden="true">
          ▾
        </span>
      </button>
      {open ? (
        <ul
          id={listId}
          className="dd-list"
          role="listbox"
          aria-labelledby={labelId}
          aria-activedescendant={`${baseId}-opt-${highlight}`}
          onKeyDown={onListKey}
        >
          {options.map((o, i) => (
            <li
              key={o.value}
              className={i === highlight ? 'is-highlight' : undefined}
            >
              <button
                ref={(el) => {
                  optionRefs.current[i] = el;
                }}
                type="button"
                role="option"
                id={`${baseId}-opt-${i}`}
                aria-selected={o.value === value}
                tabIndex={-1}
                className={o.value === value ? 'is-selected' : undefined}
                onClick={() => pick(o.value)}
                onMouseEnter={() => setHighlight(i)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    pick(o.value);
                  }
                }}
              >
                <span>{o.label}</span>
                {o.value === value ? (
                  <span className="dd-check" aria-hidden="true">
                    ✓
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
