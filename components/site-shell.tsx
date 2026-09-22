import Link from 'next/link';
import type { ReactNode } from 'react';

export function SiteShell({ children }: { children: ReactNode }) {
  return <><header className="site-header"><div className="site-container header-inner"><Link href="/" className="wordmark"><i />TradeYodha</Link><nav className="desktop-nav" aria-label="Main navigation"><Link href="/how-it-works">Product</Link><Link href="/research">Approach</Link><Link href="/about">Company</Link></nav><div className="header-actions"><Link href="/early-access" className="button button-primary">Early access</Link></div></div></header>{children}<footer className="site-footer"><div className="site-container footer-row"><p className="footer-copy">TradeYodha builds AI research tools for active market participants. Research and education only; nothing on this site is investment advice.</p><div className="footer-links"><Link href="/about">About</Link><Link href="/disclaimer">Disclaimer</Link><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link></div></div></footer></>;
}
