import { useEffect, useRef, useState } from "react";
import { SearchResult, api } from "./api";
import { geneColor } from "./theme";
import { formatPos, shortChrom } from "./view";

interface Props {
  onPick: (r: SearchResult) => void;
  onSubmit: (q: string) => void;
  onClear: () => void;
  value: string;
  setValue: (v: string) => void;
}

export default function SearchBox({ onPick, onSubmit, onClear, value, setValue }: Props) {
  const [suggestions, setSuggestions] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const q = value.trim();
    if (!q) {
      setSuggestions([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      api.search(q, undefined, 8).then((r) => !ctrl.signal.aborted && setSuggestions(r.results)).catch(() => {});
    }, 120);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [value]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement !== inputRef.current) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pick = (r: SearchResult) => {
    setOpen(false);
    inputRef.current?.blur();
    onPick(r);
  };

  return (
    <div className="search">
      <form
        className="search-box"
        onSubmit={(e) => {
          e.preventDefault();
          if (active >= 0 && suggestions[active]) pick(suggestions[active]);
          else if (value.trim()) {
            setOpen(false);
            onSubmit(value.trim());
          }
        }}
      >
        <svg className="search-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden>
          <path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
        </svg>
        <input
          ref={inputRef}
          value={value}
          placeholder="Search a trait, condition or gene — try “eye color”"
          onChange={(e) => {
            setValue(e.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setActive((a) => Math.min(suggestions.length - 1, a + 1));
            else if (e.key === "ArrowUp") setActive((a) => Math.max(-1, a - 1));
            else if (e.key === "Escape") inputRef.current?.blur();
            else return;
            e.preventDefault();
          }}
          aria-label="Search the genome"
          spellCheck={false}
        />
        {value && (
          <button
            type="button"
            className="icon-btn"
            aria-label="Clear search"
            onClick={() => {
              setValue("");
              setSuggestions([]);
              onClear();
              inputRef.current?.focus();
            }}
          >
            ×
          </button>
        )}
      </form>
      {open && suggestions.length > 0 && (
        <ul className="suggestions" role="listbox">
          {suggestions.map((r, i) => (
            <li
              key={r.kind === "gene" ? r.id : "locus"}
              className={i === active ? "active" : ""}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(r);
              }}
            >
              {r.kind === "gene" ? (
                <>
                  <span className="sugg-dot" style={{ background: geneColor(r.categories, r.type) }} />
                  <span className="sugg-main">
                    <b>{r.symbol}</b> <span className="muted">{r.blurb ?? r.description}</span>
                  </span>
                  <span className="sugg-loc">Chr {shortChrom(r.chrom)}</span>
                </>
              ) : (
                <>
                  <span className="sugg-dot" style={{ background: "#5f6368" }} />
                  <span className="sugg-main">
                    Go to <b>{r.chrom}:{formatPos(r.start + 1)}–{formatPos(r.end)}</b>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
