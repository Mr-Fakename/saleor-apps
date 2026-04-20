const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  typescript: {
    // Type checking done via `tsc --noEmit` (skipLibCheck handles @types/react version mismatch)
    ignoreBuildErrors: true,
  },
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
