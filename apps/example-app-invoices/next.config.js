// @ts-check

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  // Known monorepo issue (see saleor-apps CLAUDE.md): @types/react version
  // mismatch breaks JSX typing of Macaw UI Box during next build; type safety
  // is enforced separately via tsc --noEmit.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  transpilePackages: [
    "@saleor/apps-otel",
    "@saleor/apps-logger",
    "@saleor/apps-shared",
    "@saleor/apps-ui",
    "@saleor/react-hook-form-macaw",
  ],
  experimental: {},
};

export default nextConfig;
