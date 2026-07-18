import Link from "next/link";
import { Icon } from "@/components/icon";

export function OpsHeader({
  businessName,
  operatorEmail,
  switchAccountHref,
}: {
  businessName: string;
  operatorEmail: string | null;
  switchAccountHref?: string;
}) {
  return (
    <header className="ops-header">
      <Link className="ops-header__brand" href="/ops">
        <span className="ops-header__mark">
          <Icon name="shield" size={18} />
        </span>
        <span className="ops-header__brand-copy">
          <span className="t-eyebrow">Relay Operations</span>
          <strong>Internal console</strong>
          <span>{businessName}</span>
        </span>
      </Link>

      <div className="ops-header__right">
        <span className="ops-header__operator" title={operatorEmail ?? "Relay operator"}>
          {operatorEmail ?? "Relay operator"}
        </span>
        {switchAccountHref ? (
          <Link className="btn btn-secondary btn-sm ops-header__switch" href={switchAccountHref}>
            Switch account
          </Link>
        ) : null}
        <Link className="btn btn-secondary btn-sm ops-header__owner-app" href="/leads">
          Owner app
        </Link>
      </div>
    </header>
  );
}
