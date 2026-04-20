const path = require('path');

/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  output: 'standalone',
  // Trace files up to the monorepo root so standalone output includes
  // hoisted node_modules (next, react, etc.) that live above this app.
  outputFileTracingRoot: path.join(__dirname, '../../'),
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};
