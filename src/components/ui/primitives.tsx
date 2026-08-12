// Design-system primitives.
//
// Written for this product rather than pulled from a component library: the set
// is small, every element is token-driven, and each one behaves correctly in
// both RTL and LTR because it uses logical properties (`ms-*`, `me-*`, `text-start`)
// rather than left/right.
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { cn } from "@/lib/utils";

/* --------------------------------------------------------------- Button -- */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-brand text-text-inverse hover:bg-brand-hover",
  secondary: "border border-border bg-surface hover:bg-surface-2",
  ghost: "hover:bg-surface-2",
  danger: "bg-danger text-text-inverse hover:opacity-90",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-sm gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "primary", size = "md", type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex items-center justify-center rounded-md font-medium transition-colors",
        "disabled:pointer-events-none disabled:opacity-50",
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...props}
    />
  );
});

/* ----------------------------------------------------------------- Card -- */

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border border-border bg-surface", className)} {...props} />;
}

export function CardHeader({
  title,
  subtitle,
  actions,
  icon,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-4">
      <div className="flex items-start gap-2.5">
        {icon && <span className="mt-0.5 text-text-muted">{icon}</span>}
        <div>
          <h2 className="font-semibold leading-tight">{title}</h2>
          {subtitle && <p className="mt-0.5 text-sm text-text-muted">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4", className)} {...props} />;
}

/* ---------------------------------------------------------------- Field -- */

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string;
  /** Forces LTR for technical values (URLs, logins) inside an RTL form. */
  ltr?: boolean;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, hint, error, ltr, className, ...props },
  ref,
) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      <input
        ref={ref}
        dir={ltr ? "ltr" : undefined}
        className={cn(
          "h-10 w-full rounded-md border bg-bg px-3 text-sm outline-none transition-colors",
          "placeholder:text-text-subtle focus:border-brand",
          error ? "border-danger" : "border-border",
          className,
        )}
        {...props}
      />
      {error ? (
        <span className="block text-xs text-danger">{error}</span>
      ) : hint ? (
        <span className="block text-xs text-text-muted">{hint}</span>
      ) : null}
    </label>
  );
});

export function SelectField({
  label,
  hint,
  children,
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string; hint?: string }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      <select
        className={cn(
          "h-10 w-full rounded-md border border-border bg-bg px-3 text-sm outline-none focus:border-brand",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      {hint && <span className="block text-xs text-text-muted">{hint}</span>}
    </label>
  );
}

/* ----------------------------------------------------------------- Badge -- */

export type BadgeTone = "neutral" | "brand" | "success" | "warning" | "danger";

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "bg-surface-2 text-text-muted border-border",
  brand: "bg-brand-soft text-brand-ink border-transparent",
  success: "bg-success-soft text-success border-transparent",
  warning: "bg-warning-soft text-warning border-transparent",
  danger: "bg-danger-soft text-danger border-transparent",
};

export function Badge({
  tone = "neutral",
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        BADGE_TONES[tone],
        className,
      )}
      {...props}
    />
  );
}

/* ---------------------------------------------------------------- Notice -- */

export function Notice({
  tone = "neutral",
  title,
  children,
  icon,
}: {
  tone?: BadgeTone;
  title?: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
}) {
  const tones: Record<BadgeTone, string> = {
    neutral: "border-border bg-surface-2",
    brand: "border-brand/30 bg-brand-soft",
    success: "border-success/30 bg-success-soft",
    warning: "border-warning/40 bg-warning-soft",
    danger: "border-danger/40 bg-danger-soft",
  };
  return (
    <div className={cn("flex items-start gap-3 rounded-lg border p-3 text-sm", tones[tone])}>
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className="text-text-muted">{children}</div>}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- Table -- */

export function DataTable({ children, className }: { children: ReactNode; className?: string }) {
  // Wide tables scroll inside their own container so the page never scrolls
  // horizontally — which breaks RTL layouts particularly badly.
  return (
    <div className={cn("scroll-x rounded-lg border border-border", className)}>
      <table className="w-full min-w-[560px] text-sm">{children}</table>
    </div>
  );
}

export function Th({ className, ...props }: HTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        "border-b border-border bg-surface-2 px-3 py-2 text-start text-xs font-medium uppercase tracking-wide text-text-muted",
        className,
      )}
      {...props}
    />
  );
}

export function Td({ className, ...props }: HTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("border-b border-border px-3 py-2", className)} {...props} />;
}

/* -------------------------------------------------------------- PageHead -- */

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm text-text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-surface-2", className)} />;
}
