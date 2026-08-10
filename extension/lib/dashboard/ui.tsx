import type { ReactNode, TextareaHTMLAttributes, InputHTMLAttributes } from 'react';

/** Shared primitives for the overlay. Deliberately small — no component lib. */

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function Button({
  children,
  onClick,
  variant = 'primary',
  disabled,
  type = 'button',
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'ghost' | 'danger';
  disabled?: boolean;
  type?: 'button' | 'submit';
  className?: string;
}) {
  const base =
    'inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-full px-4 ' +
    'text-sm font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-45';

  const tones = {
    primary: 'bg-brand text-white hover:bg-brand-hover',
    ghost:
      'border border-line-strong bg-transparent text-fg hover:bg-ink-800',
    danger: 'border border-line-strong bg-transparent text-danger hover:bg-danger/10',
  } as const;

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cx(base, tones[variant], className)}
    >
      {children}
    </button>
  );
}

export function Card({
  title,
  description,
  children,
  actions,
}: {
  title?: string;
  description?: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-line bg-ink-850 p-5">
      {(title || actions) && (
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            {title && <h2 className="text-base font-bold text-fg">{title}</h2>}
            {description && (
              <p className="mt-1 max-w-prose text-sm text-fg-muted">{description}</p>
            )}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-bold tracking-wide text-fg-faint uppercase">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1.5 block text-sm text-fg-muted">{hint}</span>}
    </label>
  );
}

const controlClass =
  'w-full rounded-lg border border-line-strong bg-ink-900 px-3 py-2 text-base ' +
  'text-fg placeholder:text-fg-faint outline-none transition-colors ' +
  'focus:border-brand focus:ring-2 focus:ring-brand-wash';

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(controlClass, props.className)} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={cx(controlClass, 'resize-y leading-relaxed', props.className)}
    />
  );
}

/** Single-select pill row — the same affordance the on-page panel uses. */
export function ChipGroup({
  values,
  value,
  onChange,
  labels,
}: {
  values: readonly string[];
  value: string;
  onChange: (next: string) => void;
  labels?: Record<string, string>;
}) {
  return (
    <div role="radiogroup" className="flex flex-wrap gap-2">
      {values.map((option) => {
        const active = option === value;

        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option)}
            className={cx(
              'h-8 rounded-full border px-3.5 text-sm font-bold transition-colors',
              active
                ? 'border-brand bg-brand-wash text-brand'
                : 'border-line-strong text-fg-muted hover:bg-ink-800 hover:text-fg',
            )}
          >
            {labels?.[option] ?? option}
          </button>
        );
      })}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cx(
        'xg-anim-spin inline-block size-4 rounded-full border-2 border-current border-t-transparent',
        className,
      )}
      aria-hidden="true"
    />
  );
}

export function Banner({
  tone,
  children,
}: {
  tone: 'error' | 'success' | 'info';
  children: ReactNode;
}) {
  const tones = {
    error: 'border-danger/40 bg-danger/10 text-danger',
    success: 'border-ok/40 bg-ok/10 text-ok',
    info: 'border-line-strong bg-ink-800 text-fg-muted',
  } as const;

  return (
    <p className={cx('rounded-lg border px-3 py-2 text-sm', tones[tone])}>
      {children}
    </p>
  );
}

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-line-strong px-6 py-10 text-center">
      <p className="text-base font-bold text-fg">{title}</p>
      {children && <p className="mt-1.5 text-sm text-fg-muted">{children}</p>}
    </div>
  );
}
