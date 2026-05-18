import { cn } from "@/lib/utils";

interface CardProps {
  children: React.ReactNode;
  className?: string;
}

// Pro App card surface — flat, no shadow. Depth comes from the raised tone
// (#252527) sitting above the surface-base page background, plus the
// hairline separator border. Matches the Cards/Panels recipe in
// docs/design-system.md.
export function Card({ children, className }: CardProps) {
  return (
    <div className={cn("bg-surface-raised rounded-md border border-separator", className)}>
      {children}
    </div>
  );
}

export function CardHeader({ children, className }: CardProps) {
  return (
    <div className={cn("px-4 py-2.5 border-b border-separator", className)}>
      {children}
    </div>
  );
}

export function CardBody({ children, className }: CardProps) {
  return <div className={cn("p-4", className)}>{children}</div>;
}
