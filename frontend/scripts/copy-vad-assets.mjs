import { copyFile, mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";

// Ship VAD worklet, Silero ONNX model, and ONNX runtime locally.
// Avoid CDN/network policy failures on browsers that block external script/wasm assets.
const sources = [
  { from: "node_modules/@ricky0123/vad-web/dist", to: "public/vad", test: (name) => name === "vad.worklet.bundle.min.js" || name.endsWith(".onnx") },
  { from: "node_modules/onnxruntime-web/dist", to: "public/onnx", test: (name) => name.endsWith(".wasm") || name.endsWith(".mjs") },
];
for (const { from, to, test } of sources) {
  const source = resolve(from);
  const target = resolve(to);
  await mkdir(target, { recursive: true });
  const filenames = (await readdir(source)).filter(test);
  if (!filenames.length) throw new Error(`No VAD assets found in ${source}; run npm install first`);
  for (const filename of filenames) await copyFile(resolve(source, filename), resolve(target, filename));
  console.log(`Copied ${filenames.length} VAD runtime files into ${to}`);
}
