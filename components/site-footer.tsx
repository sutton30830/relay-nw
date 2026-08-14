import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <span>© 2026 Lowry Works LLC. Relay NW is a service operated by Lowry Works LLC.</span>
      <nav className="site-footer__links" aria-label="Legal links">
        <Link href="/privacy">Privacy Policy</Link>
        <span aria-hidden="true">|</span>
        <Link href="/terms">Terms & Conditions</Link>
        <span aria-hidden="true">|</span>
        <Link href="/sms-consent">SMS Consent</Link>
      </nav>
    </footer>
  );
}
