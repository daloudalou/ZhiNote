/**
 * 枝记 - 打包脚本
 * 用法：
 *   node publish.mjs              → 测试构建：输出到 发布版本/dev/（覆盖式），版本号 v下一号-dev，不占正式号
 *   node publish.mjs --release    → 正式构建：此刻才递增版本号，输出到 发布版本/vX.Y.Z/（sync-public.mjs 发布时自动调）
 *   node publish.mjs 1.2.3        → 指定版本号的正式构建
 *
 * 版本号只在「发布」那一刻落实——本地测试打多少次包都不占号，线上版本不跳号。
 * 构建时把版本号注入 __MD_VER__（关于页显示）与 SW 缓存名，全链路同一个 vX.Y.Z。
 * 将所有本地 CSS/JS 原样内联到单个 HTML 文件，不做任何代码变换。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'fs';
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

function getLatestVersion() {
  if (!existsSync(OUT_BASE)) return null;
  const dirs = readdirSync(OUT_BASE).filter(d => /^v\d+\.\d+\.\d+$/.test(d));
  if (!dirs.length) return null;
  const versions = dirs.map(d => d.slice(1));
  versions.sort(compareVersions);
  return versions[versions.length - 1];
}

function getNextVersion() {
  const last = getLatestVersion();
  if (!last) return '1.0.0';
  const parts = last.split('.').map(Number);
  parts[2] = (parts[2] || 0) + 1;
  return parts.join('.');
}

const _args = process.argv.slice(2);
const _manualVer = _args.find(a => /^\d+\.\d+\.\d+$/.test(a));
const isRelease = _args.includes('--release') || !!_manualVer;
if (_manualVer) {
  const last = getLatestVersion();
  if (last && compareVersions(_manualVer, last) <= 0) {
    console.error(`指定版本 v${_manualVer} 不大于当前最新 v${last}，版本号只能往前走。`);
    process.exit(1);
  }
}
const version = _manualVer || getNextVersion();
const verLabel = isRelease ? `v${version}` : `v${version}-dev`;
const outDir = isRelease ? join(OUT_BASE, `v${version}`) : join(OUT_BASE, 'dev');
if (isRelease && existsSync(outDir)) {
  console.error(`版本目录已存在：${outDir}\n请使用新版本号或手动删除该目录。`);
  process.exit(1);
}
if (!isRelease) rmSync(outDir, { recursive: true, force: true }); // 测试构建覆盖式输出

console.log(`\n📦 枝记 ${isRelease ? '正式构建' : '测试构建（不占版本号）'} ${verLabel}\n`);

let output = readFileSync(join(SRC, 'index.html'), 'utf8');

// 注入版本号：关于页/控制台显示的 __MD_VER__ 与 GitHub 版本号全链路统一为 vX.Y.Z
output = output.replace(/window\.__MD_VER__ = '[^']*'/, `window.__MD_VER__ = '${verLabel}'`);

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
// 全局替换：__SW_VER__ 在注释里也出现，replace(字符串) 只换第一处会漏掉 VERSION 常量，
// 导致历次发布的 sw.js 内容相同、浏览器判定"无更新"，更新提示永不触发（曾发生）
const sw = readFileSync(join(SRC, 'sw.js'), 'utf8').replace(/__SW_VER__/g, verLabel);
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
console.log(`   版本：${verLabel}${isRelease ? '' : '（测试包；发布时才落实正式版本号）'}\n`);

// 打开文件所在位置并选中（正式发布由 sync-public 静默调用，不弹资源管理器）
if (!isRelease) {
  try {
    execSync(`explorer /select,"${outFile}"`);
  } catch (_) {}
}
