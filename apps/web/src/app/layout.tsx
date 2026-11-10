import type { Metadata, Viewport } from 'next';
import { I18nProvider } from '../lib/i18n';
import { Inter } from 'next/font/google';
import './globals.css';
import { AuthProvider } from '../lib/auth';
import Nav from '../components/nav';
import { SearchPalette } from '../components/search/search-palette';
import { AuthGate } from '../components/auth-gate';
import { PwaSetup } from '../components/pwa-setup';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: 'Hive',
  description: 'Chat, communities and calls in one place.',
  manifest: '/manifest.webmanifest',
  icons: { icon: [{ url: '/icon.svg', type: 'image/svg+xml' }, { url: '/icon-192.png', sizes: '192x192', type: 'image/png' }], apple: '/apple-touch-icon.png' },
  appleWebApp: { capable: true, title: 'Hive', statusBarStyle: 'default' },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f5fb' },
    { media: '(prefers-color-scheme: dark)', color: '#0d0b17' },
  ],
};

// Runs before the first paint so the saved theme (light, dark or system) never flashes.
const themeScript = `try{var t=localStorage.getItem('hive:theme')||'system';var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d)}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head>
      <body className="min-h-screen font-sans antialiased">
        <I18nProvider><AuthProvider><PwaSetup /><Nav /><SearchPalette /><AuthGate>{children}</AuthGate></AuthProvider></I18nProvider>
      </body>
    </html>
  );
}
