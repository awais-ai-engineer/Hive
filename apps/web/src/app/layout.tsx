import type { Metadata } from 'next';
import './globals.css';
import { AuthProvider } from '../lib/auth';
import Nav from '../components/nav';

export const metadata: Metadata = {
  title: 'Hive',
  description: 'Communities, chat and voice in one place.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <AuthProvider><Nav />{children}</AuthProvider>
      </body>
    </html>
  );
}
