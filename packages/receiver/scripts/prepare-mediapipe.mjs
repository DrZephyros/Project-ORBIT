/**
 * Copy MediaPipe's WASM runtime and the two task models into the receiver's
 * public directory.
 *
 * They are deliberately not checked in: together they are ~26 MB, they belong
 * to packages that already ship them (the npm package and the Python service),
 * and copying at build time keeps the two sides on exactly the same model
 * version. Vite copies `public/` into `dist/`, and the ORBIT server exposes
 * that directory at `/mediapipe/`.
 *
 * The copy is skipped when the destination already has a file of the same size,
 * so a rebuild does not rewrite 26 MB every time.
 */

import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const receiver = resolve(here, '..');
const repo = resolve(receiver, '..', '..');

const wasmSrc = resolve(repo, 'node_modules/@mediapipe/tasks-vision/wasm');
const modelsSrc = resolve(repo, 'services/gestures/models');
const dest = resolve(receiver, 'public/mediapipe');

function copyIfChanged(from, to) {
  if (!existsSync(from)) {
    throw new Error(`MediaPipe asset missing: ${from}`);
  }
  mkdirSync(dirname(to), { recursive: true });
  if (existsSync(to) && statSync(to).size === statSync(from).size) return;
  copyFileSync(from, to);
  console.log(`[mediapipe] copied ${to.replace(repo + '\\', '').replace(repo + '/', '')}`);
}

const wasmFiles = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm'];
for (const name of wasmFiles) {
  copyIfChanged(join(wasmSrc, name), join(dest, 'wasm', name));
}

for (const name of ['hand_landmarker.task', 'face_landmarker.task']) {
  copyIfChanged(join(modelsSrc, name), join(dest, 'models', name));
}

console.log('[mediapipe] assets ready in packages/receiver/public/mediapipe');
