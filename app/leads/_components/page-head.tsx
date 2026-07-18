import type { ReactNode } from "react";

export function PageHead({
  actions,
  eyebrow,
  subtitle,
  title,
}: {
  actions?: ReactNode;
  eyebrow: string;
  subtitle?: ReactNode;
  title: ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        <p className="t-eyebrow">{eyebrow}</p>
        <h1 className="t-display page-head__title">{title}</h1>
        {subtitle ? <p className="leads-subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-head__actions">{actions}</div> : null}
    </header>
  );
}
