import { cn } from "@/lib/utils";

interface BadgeProps {
  children: React.ReactNode;
  className?: string;
}

export function Badge({ children, className }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center h-5 px-1.5 py-0.5 rounded-sm text-xs font-medium leading-none bg-surface-hover text-text-secondary [&_[data-mono],&_.data-mono]:font-mono",
        className,
      )}
    >
      {children}
    </span>
  );
}
