import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Produces a minimal self-contained server bundle for the runtime Docker
  // stage, so the production image does not ship node_modules.
  output: 'standalone',
  outputFileTracingIncludes: {
    // The Prisma query engine is resolved at runtime and is not discovered by
    // static analysis, so it must be traced into the standalone output.
    '/**': ['./src/generated/prisma/**/*'],
  },
  serverExternalPackages: [
    '@prisma/client',
    'pg',
    'pg-boss',
    'imapflow',
    'nodemailer',
    'mailparser',
    'exceljs',
    'pdfkit',
    'pino',
  ],
  experimental: {
    // Server Actions receive file uploads for ticket attachments.
    serverActions: { bodySizeLimit: '12mb' },
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-DNS-Prefetch-Control', value: 'off' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
