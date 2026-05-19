import type { NextConfig } from 'next'

const config: NextConfig = {
  output: process.env.BUILD_STATIC === '1' ? 'export' : undefined,
}
export default config
