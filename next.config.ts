import type { NextConfig } from 'next'
import path from 'node:path'

const nextConfig: NextConfig = {
  // Keep `next build` from replacing the filesystem artifacts used by a live
  // `next dev` process (both normally share `.next`).
  distDir:
    process.env.NODE_ENV === 'production'
      ? '.next-production'
      : '.next-development',
  devIndicators: false,
  outputFileTracingRoot: path.resolve(process.cwd(), '..'),
  experimental: { cpus: 1 }
}

export default nextConfig
