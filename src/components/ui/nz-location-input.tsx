"use client";

import { useEffect, useRef, useState } from "react";
import { MapPin, X } from "lucide-react";
import { NZ_CITIES } from "@/lib/nz-cities";
import { cn } from "@/lib/utils";

/**
 * NZ-only location autocomplete.
 *
 * Filters NZ_CITIES on every keystroke (both .name and .keywords).
 * On selection the canonical .name is returned so the search/scoring
 * layer can resolve it to actual coordinates via getCityCoords().
 *
 * "New Zealand" is offered as a special catch-all so recruiters can
 * run a nationwide search without picking a specific city.
 */

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  /** When true also includes "New Zealand" as a top option */
  allowNationwide?: boolean;
}

const MAX_SUGGESTIONS = 8;

function matchCity(city: typeof NZ_CITIES[number], query: string): boolean {
  const q = query.toLowerCase().trim();
  if (!q) return true;
  if (city.name.toLowerCase().includes(q)) return true;
  return city.keywords.some((k) => k.toLowerCase().includes(q));
}

export function NZLocationInput({
  value,
  onChange,
  placeholder = "e.g. Wellington",
  className,
  disabled,
  allowNationwide = true,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep local query in sync when parent resets the value
  useEffect(() => { setQuery(value); }, [value]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const suggestions = (() => {
    const q = query.trim();
    const cities = NZ_CITIES.filter((c) => matchCity(c, q)).slice(0, MAX_SUGGESTIONS);
    if (allowNationwide && "new zealand".includes(q.toLowerCase())) {
      return [{ name: "New Zealand", keywords: [], lat: -41, lng: 174, isNationwide: true }, ...cities].slice(0, MAX_SUGGESTIONS);
    }
    return cities.map((c) => ({ ...c, isNationwide: false }));
  })();

  const select = (name: string) => {
    setQuery(name);
    onChange(name);
    setOpen(false);
  };

  const clear = () => { setQuery(""); onChange(""); inputRef.current?.focus(); };

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <div className="relative">
        <MapPin className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => {
            setQuery(e.target.value);
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { setOpen(false); }
            if (e.key === "Enter" && suggestions.length === 1) { select(suggestions[0].name); }
          }}
          className="w-full pl-8 pr-7 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 bg-white"
          autoComplete="off"
        />
        {query && !disabled && (
          <button
            type="button"
            onClick={clear}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-300 hover:text-slate-500"
            aria-label="Clear location"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {open && suggestions.length > 0 && (
        <div className="absolute z-50 left-0 right-0 top-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg overflow-hidden">
          {suggestions.map((city) => (
            <button
              key={city.name}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); select(city.name); }}
              className="w-full text-left flex items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-blue-50 hover:text-blue-700 transition-colors"
            >
              <MapPin className={cn("w-3.5 h-3.5 flex-shrink-0", "isNationwide" in city && city.isNationwide ? "text-slate-300" : "text-slate-400")} />
              <span>{city.name}</span>
              {"isNationwide" in city && city.isNationwide && (
                <span className="text-[10px] text-slate-400 ml-auto">Nationwide</span>
              )}
            </button>
          ))}
        </div>
      )}

      {open && query.trim().length >= 2 && suggestions.length === 0 && (
        <div className="absolute z-50 left-0 right-0 top-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg px-3 py-2 text-xs text-slate-400">
          No NZ locations match &ldquo;{query}&rdquo;
        </div>
      )}
    </div>
  );
}
