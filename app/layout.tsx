import type { Metadata } from 'next';
import { DM_Sans, DM_Mono, Instrument_Serif } from 'next/font/google';
import './globals.css';

const sans = DM_Sans({ variable: '--font-sans', subsets: ['latin'] });
const mono = DM_Mono({ variable: '--font-mono', subsets: ['latin'], weight: ['400', '500'] });
const serif = Instrument_Serif({ variable: '--font-serif', subsets: ['latin'], weight: '400' });

export const metadata: Metadata = {
  title: 'TradeYodha | Agentic Market Intelligence',
  description: 'An AI research desk for active traders who want clearer market context around the levels they trade.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${sans.variable} ${mono.variable} ${serif.variable}`}>{children}</body></html>;
}
