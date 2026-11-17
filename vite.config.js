import { defineConfig } from 'vite';
import { studioApi } from './studio/server.mjs';

export default defineConfig({
  plugins: [studioApi()],
  server: {
    host: '127.0.0.1',
    // 絵画化の途中で書かれるファイルで画面が読み直されないようにする
    watch: { ignored: ['**/previz-export/**', '**/paint/out/**'] },
  },
});
