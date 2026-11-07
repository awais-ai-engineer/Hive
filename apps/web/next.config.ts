import type { NextConfig } from 'next';

// In production the API runs on another domain. Auth calls are proxied through this site so the
// refresh cookie is first-party (see AUTH_URL in src/lib/api.ts).
const apiOrigin = process.env.API_PROXY_TARGET;

const nextConfig: NextConfig = {
  async rewrites() {
    return apiOrigin ? [{ source: '/api/auth/:path*', destination: `${apiOrigin}/api/auth/:path*` }] : [];
  },
};

export default nextConfig;
