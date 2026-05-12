"use client";

import { cn } from "@/lib/utils";
import { type ButtonHTMLAttributes, forwardRef } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "outline";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", loading, disabled, children, ...props }, ref) => {
    const base =
      "inline-flex items-center justify-center font-medium rounded transition-colors focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-50 disabled:pointer-events-none";

    const variants = {
      primary:
        "bg-accent hover:bg-accent-hover text-white",
      secondary:
        "bg-surface-hover hover:bg-surface-overlay text-text-primary border border-separator",
      ghost:
        "text-text-secondary hover:text-text-primary hover:bg-surface-hover",
      danger:
        "bg-danger-subtle hover:bg-danger/30 text-danger",
      outline:
        "border border-separator text-text-primary hover:bg-surface-hover",
    };

    const sizes = {
      sm: "h-6 px-3 text-sm gap-1.5",
      md: "h-7 px-3 text-md gap-1.5",
      lg: "h-8 px-3 text-md gap-2",
    };

    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn(base, variants[variant], sizes[size], className)}
        {...props}
      >
        {loading && (
          <svg className="animate-spin h-3.5 w-3.5" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
        )}
        {children}
      </button>
    );
  }
);
Button.displayName = "Button";

export { Button };
