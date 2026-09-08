/**
 * next.config.mjs
 *
 * Deliberately small. Configuration that changes behaviour belongs in config/*.yaml or in the
 * environment; this file only states how the app is built and served.
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  // A container image serves the app; the standalone output ships only the traced dependencies.
  output: 'standalone',

  // React strict mode stays on. The double-invoke in development is how an effect that writes
  // twice is found before it writes twice in production.
  reactStrictMode: true,

  // A failing type check must fail the build. Both of these default to false already; they are
  // written out because setting either to true is the shortcut that ships a broken page, and an
  // explicit false is harder to flip by accident than an absent key.
  typescript: { ignoreBuildErrors: false },

  // The build must not leak the release identity into the client bundle beyond what the health
  // route already publishes. APP_RELEASE is read server-side only.
  poweredByHeader: false,

  // `pg` is a native-ish driver: it must never be bundled for the browser, and it must not be
  // traced into the edge. Every module that touches it imports 'server-only'.
  serverExternalPackages: ['pg'],

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
