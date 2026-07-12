import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages 프로젝트 사이트: https://jiyu-ng.github.io/zzanji/
export default defineConfig({
  base: '/zzanji/',
  plugins: [react()],
});
