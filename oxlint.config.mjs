import { defineConfig } from 'oxlint';

export default defineConfig({
  categories: { correctness: 'error' },
  rules: {
    curly: 'error',
    'id-length': ['error', { min: 3, exceptions: ['on', 'id', 'ok', '_', '__'] }]
  },
  env: { builtin: true, node: true }
});
