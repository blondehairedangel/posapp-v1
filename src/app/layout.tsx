import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ToastProvider } from '@/components/ui/feedback';

export const metadata: Metadata = {
  title: {
    default: 'Spare Parts ERP',
    template: '%s · Spare Parts ERP',
  },
  description:
    'Automotive spare parts ERP with inventory, sales, purchasing and customer order ticketing.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="id">
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
