import type { ReactNode } from 'react';
import { CheckCircle2, AlertCircle, X } from 'lucide-react';

export function AppleSwitch({
  checked,
  disabled = false,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={`relative inline-flex h-[24px] w-[42px] shrink-0 cursor-pointer items-center rounded-full p-[2px] transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue ${
        disabled ? 'opacity-45 cursor-not-allowed' : ''
      }`}
      style={{
        backgroundColor: checked
          ? 'var(--apple-green)'
          : 'var(--separator-strong)',
      }}
    >
      <span
        className={`inline-block h-[20px] w-[20px] transform rounded-full bg-white shadow-sm transition-transform duration-200 ${
          checked ? 'translate-x-[18px]' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
}: {
  options: Array<{ value: T; label: string; dot?: boolean }>;
  value: T;
  onChange: (val: T) => void;
  size?: 'sm' | 'md';
}) {
  return (
    <div
      className="inline-flex flex-wrap items-center gap-0.5 rounded-[11px] p-[3px]"
      style={{
        backgroundColor: 'var(--bg-grouped)',
        border: '1px solid var(--separator)',
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`inline-flex items-center gap-1.5 rounded-[8px] font-medium transition-all duration-150 ${
              size === 'sm' ? 'px-2.5 py-1 text-[12px]' : 'px-3 py-1.5 text-[13px]'
            } ${
              active
                ? 'bg-apple-card text-apple-label shadow-sm'
                : 'text-apple-secondary hover:text-apple-label'
            }`}
          >
            <span>{opt.label}</span>
            {opt.dot && (
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: 'var(--apple-red)' }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

export function InsetGroup({
  title,
  action,
  children,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      {(title || action) && (
        <div className="flex items-center justify-between px-1">
          {title && (
            <span className="text-[12px] font-semibold uppercase tracking-wide text-apple-secondary">
              {title}
            </span>
          )}
          {action}
        </div>
      )}
      <div className="apple-card overflow-hidden divide-y divide-[var(--separator)]">
        {children}
      </div>
    </div>
  );
}

export function InsetRow({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`px-4 py-3 ${className}`}>
      {children}
    </div>
  );
}

export function ToastBanner({
  toast,
  onDismiss,
}: {
  toast: { type: 'success' | 'error'; text: string } | null;
  onDismiss: () => void;
}) {
  if (!toast) return null;
  const isErr = toast.type === 'error';
  return (
    <div className="pointer-events-none fixed left-1/2 top-4 z-[70] -translate-x-1/2">
      <div
        className="apple-glass pointer-events-auto flex items-center gap-2.5 rounded-full border px-4 py-2 text-[13px] font-medium shadow-apple-popover"
        style={{
          color: 'var(--label-primary)',
        }}
      >
        {isErr ? (
          <AlertCircle className="h-4 w-4 shrink-0" style={{ color: 'var(--apple-red)' }} />
        ) : (
          <CheckCircle2 className="h-4 w-4 shrink-0" style={{ color: 'var(--apple-green)' }} />
        )}
        <span>{toast.text}</span>
        <button
          type="button"
          onClick={onDismiss}
          className="ml-1 rounded-full p-0.5 text-apple-tertiary hover:text-apple-label"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
