import type { Metadata } from 'next';
import { ReversalResearchDashboard } from './reversal-research-dashboard';

export const metadata: Metadata = {
  title: 'AMD Reversal Research | TradeYodha',
  description: 'Interactive scoring and volume analysis for AMD 0.70 opening-range reversals.',
};

export default function AmdReversalResearchPage() {
  return <ReversalResearchDashboard />;
}
