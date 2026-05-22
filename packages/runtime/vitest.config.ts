import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      'nano-rspow-node': resolve(__dirname, '../../__mocks__/nano-rspow-node.ts'),
    },
  },
});
