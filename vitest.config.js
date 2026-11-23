import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  // Compiles `.svelte` files for component tests, which render on the server (`svelte/server`).
  plugins: [svelte()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.js', 'scripts/**/*.test.js', 'tests/scenarios/**/*.test.js'],
  },
});
