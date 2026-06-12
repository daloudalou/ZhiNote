/**
 * 枝记 - 一键发布脚本
 * 用法：node publish.mjs [版本号]
 * 无参数时自动递增上次版本号
 *
 * 将所有本地 CSS/JS 原样内联到单个 HTML 文件，不做任何代码变换。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';

const ROOT = resolve(import.meta.dirname);
const SRC = join(ROOT, 'src');
const OUT_BASE = join(ROOT, '发布版本');

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function getNextVersion() {
  if (!existsSync(OUT_BASE)) return '1.0.0';
  const dirs = readdirSync(OUT_BASE).filter(d => /^v\d+\.\d+\.\d+$/.test(d));
  if (!dirs.length) return '1.0.0';
  const versions = dirs.map(d => d.slice(1));
  versions.sort(compareVersions);
  const last = versions[versions.length - 1];
  const parts = last.split('.').map(Number);
  parts[2] = (parts[2] || 0) + 1;
  return parts.join('.');
}

const version = process.argv[2] || getNextVersion();
const outDir = join(OUT_BASE, `v${version}`);
if (existsSync(outDir)) {
  console.error(`版本目录已存在：${outDir}\n请使用新版本号或手动删除该目录。`);
  process.exit(1);
}

console.log(`\n📦 枝记 发布构建 v${version}\n`);

let output = readFileSync(join(SRC, 'index.html'), 'utf8');

// 内联 CSS
output = output.replace(
  /<link([^>]*)href=["'](?!https?:\/\/)([\w.-]+\.css)[^"']*["']([^>]*)>/gi,
  (match, before, filename, after) => {
    const css = readFileSync(join(SRC, filename), 'utf8');
    console.log(`  内联 ${filename} (${(css.length / 1024).toFixed(1)}KB)`);
    return `<style>\n${css}\n</style>`;
  }
);

// 内联 JS（保留 CDN 外链不动）
output = output.replace(
  /<script([^>]*)\s+src=["'](?!https?:\/\/)([\w.-]+\.js)[^"']*["']([^>]*)><\/script>/gi,
  (match, before, filename, after) => {
    const code = readFileSync(join(SRC, filename), 'utf8');
    console.log(`  内联 ${filename} (${(code.length / 1024).toFixed(1)}KB)`);
    return `<script>\n${code}\n</script>`;
  }
);

// 输出
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'ZhiNote.html');
// 单文件版（Quicker，file:// 打开）：favicon 内联为 data URI，避免 icon.svg 404（网页版有真实文件，不改）
const iconB64 = Buffer.from(readFileSync(join(SRC, 'icon.svg'), 'utf8')).toString('base64');
const outputApp = output.replace(
  /<link rel="icon"[^>]*href=["']icon\.svg["'][^>]*>/i,
  `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${iconB64}">`
);
writeFileSync(outFile, outputApp, 'utf8');

// 网页版（PWA）：同一份单文件 + SW/manifest/图标，整个 web 文件夹拖给 Netlify / Cloudflare Pages 即可部署
const webDir = join(outDir, 'web');
mkdirSync(webDir, { recursive: true });
writeFileSync(join(webDir, 'index.html'), output, 'utf8');
const sw = readFileSync(join(SRC, 'sw.js'), 'utf8').replace('__SW_VER__', `v${version}`);
writeFileSync(join(webDir, 'sw.js'), sw, 'utf8');
writeFileSync(join(webDir, 'manifest.webmanifest'), readFileSync(join(SRC, 'manifest.webmanifest'), 'utf8'), 'utf8');
writeFileSync(join(webDir, 'icon.svg'), readFileSync(join(SRC, 'icon.svg'), 'utf8'), 'utf8');
// PNG 图标：iOS 主屏图标不吃 SVG，manifest 也需要 PNG 兜底
for (const f of ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png']) {
  writeFileSync(join(webDir, f), readFileSync(join(SRC, f)));
}
console.log(`  网页版输出 → ${webDir}（含 sw.js / manifest / icon）`);

const finalSize = Buffer.byteLength(output, 'utf8');
console.log(`\n✅ 构建完成！`);
console.log(`   输出：${outFile}`);
console.log(`   大小：${(finalSize / 1024).toFixed(1)}KB`);
console.log(`   版本：v${version}\n`);

// 打开文件所在位置并选中
try {
  execSync(`explorer /select,"${outFile}"`);
} catch (_) {}
