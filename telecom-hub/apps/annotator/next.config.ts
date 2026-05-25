import type { NextConfig } from 'next'

const config: NextConfig = {
  output: 'export',
  basePath: process.env.TAURI_BUILD === '1' ? '' : '/annotator',
  trailingSlash: true,
}
export default config
