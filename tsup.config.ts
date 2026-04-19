import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  // Bundle all dependencies into the dist so the plugin is fully self-contained.
  // Installed packages have no node_modules, so nothing can be left external.
  noExternal: [/.*/],
})
