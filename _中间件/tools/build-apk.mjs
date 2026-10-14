#!/usr/bin/env node
/**
 * DSH 手机版 APK 手工构建脚本（无需 Gradle / Android 项目 / 网络依赖）。
 *
 * 流水线：
 *   1) aapt2 compile  编译 res/ 为 .flat 文件
 *   2) aapt2 link    生成未签名基础 APK + R.java
 *   3) javac         把 Java 源码 + R.java 编译成 .class
 *   4) d8            把 .class 转成 classes.dex
 *   5) 打包          dex 写入 APK
 *   6) zipalign     4 字节对齐
 *   7) apksigner    用 debug/release 密钥签名
 *
 * 用法：node build-apk.mjs [--release]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, rmSync, copyFileSync, readFileSync } from 'node:fs';
import { join, relative, resolve, dirname, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const TC = join(ROOT, '_中间件', 'toolchain');

// aapt2/d8 对非 ASCII 路径支持有缺陷（实测中文路径下报
// "Failed to stat file ...android.jar"，尽管文件存在）。
// 因此整个构建在纯 ASCII 暂存目录 C:\dsh-mobile-build 下进行，
// 产物再拷回任务目录。
const STAGE = 'C:\\dsh-mobile-build';
const STAGE_SRC = join(STAGE, 'src');
const STAGE_BUILD = join(STAGE, 'build');
const STAGE_OUT = join(STAGE, 'dist');

// 工具链优先用 C:\dsh-mobile-build\toolchain（ASCII 路径副本）——
// 实测 aapt2 无法 stat 含中文的 android.jar 路径。
// 若副本不存在则退回任务目录内的原件（那时构建会失败）。
const TC_ASCII = 'C:\\dsh-mobile-build\\toolchain';
function toolPath(rel) {
  const ascii = join(TC_ASCII, rel);
  return existsSync(ascii) ? ascii : join(TC, rel);
}

const JDK = toolPath('jdk-17.0.2');
const SDK = toolPath('android-sdk');
const BT = join(SDK, 'build-tools', '34.0.0');
const PLATFORM = join(SDK, 'platforms', 'android-34');
const ANDROID_JAR = join(PLATFORM, 'android.jar');

const SRC = join(ROOT, 'app', 'src', 'main');
const RES = join(SRC, 'res');
const JAVA = join(SRC, 'java');
const MANIFEST = join(SRC, 'AndroidManifest.xml');

const OUT = join(ROOT, 'dist');
const RELEASE = process.argv.includes('--release');
const KEYSTORE = join(STAGE, 'dsh-mobile.keystore');

const APK_NAME = RELEASE ? 'DSH手机版-v1.0.apk' : 'DSH手机版-v1.0-debug.apk';

function run(cmd, args, opts = {}) {
  const t0 = Date.now();
  try {
    execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    const ms = Date.now() - t0;
    console.log(`  [ok ${String(ms).padStart(5)}ms] ${basename(cmd)} ${args.slice(0, 4).join(' ')}${args.length > 4 ? ' …' : ''}`);
  } catch (e) {
    console.error(`\n❌ 失败: ${basename(cmd)} ${args.join(' ')}`);
    if (e.stdout) console.error('stdout:', e.stdout.toString().slice(0, 2000));
    if (e.stderr) console.error('stderr:', e.stderr.toString().slice(0, 3000));
    process.exit(1);
  }
}

function win(p) { return p; }  // Windows 下直接传原生路径给 execFileSync

/** 递归列目录。 */
function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function main() {
  console.log(`\n═══ DSH 手机版 APK 构建 ═══  模式: ${RELEASE ? 'release(已签名)' : 'debug'}\n`);

  // 前置校验（在暂存前的原始位置检查）
  for (const [name, p] of [
    ['javac', join(JDK, 'bin', 'javac.exe')],
    ['java', join(JDK, 'bin', 'java.exe')],
    ['keytool', join(JDK, 'bin', 'keytool.exe')],
    ['aapt2', join(BT, 'aapt2.exe')],
    ['d8', join(BT, 'd8.bat')],
    ['zipalign', join(BT, 'zipalign.exe')],
    ['apksigner', join(BT, 'apksigner.bat')],
    ['android.jar', ANDROID_JAR],
    ['AndroidManifest', MANIFEST],
    ['res 目录', RES],
    ['java 源码目录', JAVA],
  ]) {
    if (!existsSync(p)) { console.error(`❌ 缺少 ${name}: ${p}`); process.exit(1); }
  }
  console.log('✅ 工具链与源码齐备');

  // ── 暂存：源码复制到 ASCII 路径 ──────────────────
  console.log(`\n暂存源码到 ${STAGE_SRC}`);
  rmSync(STAGE_SRC, { recursive: true, force: true });
  mkdirSync(STAGE_SRC, { recursive: true });
  copyTree(SRC, STAGE_SRC);
  const S_RES = join(STAGE_SRC, 'res');
  const S_JAVA = join(STAGE_SRC, 'java');
  const S_MANIFEST = join(STAGE_SRC, 'AndroidManifest.xml');
  console.log('   完成');

  rmSync(STAGE_BUILD, { recursive: true, force: true });
  mkdirSync(STAGE_BUILD, { recursive: true });
  mkdirSync(OUT, { recursive: true });

  // ── 1) aapt2 compile ─────────────────────────────
  // ⚠️ 关键：aapt2 compile 的 -o 必须是【目录】。
  //    传单个文件时它按 zip 写（magic = PK\x03\x04），
  //    link 阶段读出来必然报 "magic value is 0x04034b50 but AAPT expects 0x54504141"。
  //    传目录时才产出正确的 .flat（magic = "AAPT"）。
  //    实测确认：-o dir  → values_colors.arsc.flat，magic 41 41 50 54 ✅
  //               -o file → 同输入，magic 50 4B 03 04 ❌
  console.log('\n① 编译资源');
  const flatDir = join(STAGE_BUILD, 'flat');
  rmSync(flatDir, { recursive: true, force: true });
  mkdirSync(flatDir, { recursive: true });
  const resFiles = walk(S_RES).filter(f => extname(f) !== '.flat');
  console.log(`   共 ${resFiles.length} 个资源文件`);
  // 逐个编译，每个都用各自的临时目录，避免同名资源互相覆盖
  for (const f of resFiles) {
    const tmpOut = join(flatDir, 'one');
    rmSync(tmpOut, { recursive: true, force: true });
    mkdirSync(tmpOut, { recursive: true });
    run(win(join(BT, 'aapt2.exe')), ['compile', win(f), '-o', win(tmpOut)]);
    // aapt2 生成的文件名形如 <原名>.<ext>.flat 或 <原名>.arsc.flat
    for (const produced of readdirSync(tmpOut)) {
      const srcP = join(tmpOut, produced);
      const dstP = join(flatDir, produced);
      copyFileSync(srcP, dstP);
    }
    rmSync(tmpOut, { recursive: true, force: true });
  }
  const flatList = readdirSync(flatDir).map(n => join(flatDir, n));
  if (!flatList.length) { console.error('❌ 未产出任何 .flat'); process.exit(1); }
  console.log(`   产出 ${flatList.length} 个 .flat`);

  // ── 2) aapt2 link ────────────────────────────────
  console.log('\n② 链接生成基础 APK 与 R.java');
  const baseApk = join(STAGE_BUILD, 'base.apk');
  const genDir = join(STAGE_BUILD, 'gen');
  const linkArgs = [
    'link', '-o', win(baseApk),
    '-I', win(ANDROID_JAR),
    '--manifest', win(S_MANIFEST),
    '--java', win(genDir),
    '--min-sdk-version', '24',
    '--target-sdk-version', '34',
    '--version-code', '1',
    '--version-name', '1.0',
    '--auto-add-overlay',
  ];
  for (const f of flatList) linkArgs.push(win(f));
  run(win(join(BT, 'aapt2.exe')), linkArgs);

  // ── 3) javac ─────────────────────────────────────
  console.log('\n③ 编译 Java');
  const classesDir = join(STAGE_BUILD, 'classes');
  mkdirSync(classesDir, { recursive: true });
  const sources = walk(S_JAVA).filter(f => extname(f) === '.java');
  const rFiles = walk(genDir).filter(f => extname(f) === '.java');
  // 注意：JDK 12+ 已移除 -bootclasspath（报"目标 17 不支持该选项"）。
  // Android 编译只需 -classpath 指向 android.jar，
  // 并用 -source/-target 17 配 --release 让 javac 用 JDK 自身的平台类做基准。
  console.log(`   Java 源 ${sources.length} 个 + R.java ${rFiles.length} 个`);
  run(win(join(JDK, 'bin', 'javac.exe')), [
    '-encoding', 'UTF-8',
    '--release', '17',
    '-classpath', win(ANDROID_JAR),
    '-d', win(classesDir),
    ...sources.map(win), ...rFiles.map(win),
  ]);

  // ── 4) d8 ────────────────────────────────────────
  console.log('\n④ 转为 dex');
  const dexDir = join(STAGE_BUILD, 'dex');
  mkdirSync(dexDir, { recursive: true });
  const classFiles = walk(classesDir).filter(f => extname(f) === '.class');
  console.log(`   class 文件 ${classFiles.length} 个`);
  const d8Args = [
    '--lib', win(ANDROID_JAR),
    '--release',
    '--min-api', '24',
    '--output', win(dexDir),
    ...classFiles.map(win),
  ];
  // d8.bat 与 apksigner.bat 都用 JAVA_HOME 找 java，必须注入。
  // 否则报 "ERROR: JAVA_HOME is not set and no 'java' command could be found in your PATH."
  const javaBin = join(JDK, 'bin');
  process.env.JAVA_HOME = JDK;
  process.env.PATH = `${javaBin};${process.env.PATH || ''}`;
  run('cmd.exe', ['/c', win(join(BT, 'd8.bat')), ...d8Args], { shell: false });

  // ── 5) 打包 dex 进 APK ───────────────────────────
  console.log('\n⑤ 写入 dex');
  const withDexApk = join(STAGE_BUILD, 'base-dex.apk');
  copyFileSync(baseApk, withDexApk);
  execFileSync(win(join(JDK, 'bin', 'jar.exe')), [
    'uf', win(withDexApk),
    '-C', win(dexDir), 'classes.dex',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  console.log('   classes.dex 已装入');

  // ── 6) zipalign ──────────────────────────────────
  console.log('\n⑥ 4 字节对齐');
  const alignedApk = join(STAGE_BUILD, 'aligned.apk');
  run(win(join(BT, 'zipalign.exe')), ['-f', '-p', '4', win(withDexApk), win(alignedApk)]);

  // ── 7) 签名 ──────────────────────────────────────
  console.log('\n⑦ 签名');
  if (!existsSync(KEYSTORE)) {
    console.log('   生成签名密钥（alias=dshmobile, 有效期 10000 天）');
    run(win(join(JDK, 'bin', 'keytool.exe')), [
      '-genkeypair', '-v',
      '-keystore', win(KEYSTORE),
      '-alias', 'dshmobile',
      '-keyalg', 'RSA', '-keysize', '2048',
      '-validity', '10000',
      '-storepass', 'dshmobile2026',
      '-keypass', 'dshmobile2026',
      '-dname', 'CN=DSH Mobile, OU=DSH, O=DeepSeek, L=Guangzhou, ST=Guangdong, C=CN',
    ]);
  } else {
    console.log('   复用已有签名密钥');
  }
  mkdirSync(STAGE_OUT, { recursive: true });
  const stageFinal = join(STAGE_OUT, 'dsh-mobile.apk');
  run('cmd.exe', ['/c', win(join(BT, 'apksigner.bat')), 'sign',
    '--ks', win(KEYSTORE),
    '--ks-pass', 'pass:dshmobile2026',
    '--key-pass', 'pass:dshmobile2026',
    '--out', win(stageFinal),
    win(alignedApk)]);

  // ── 拷回任务目录 ─────────────────────────────────
  mkdirSync(OUT, { recursive: true });
  const finalApk = join(OUT, APK_NAME);
  copyFileSync(stageFinal, finalApk);

  // ── 校验 ─────────────────────────────────────────
  const size = statSync(finalApk).size;
  console.log('\n✅ 构建成功');
  console.log(`   ${finalApk}`);
  console.log(`   大小 ${(size / 1024).toFixed(1)} KB (${size} bytes)`);

  // badging 自检
  try {
    const badging = execFileSync(win(join(BT, 'aapt2.exe')), [
      'dump', 'badging', win(finalApk),
    ]).toString();
    const lines = badging.split('\n');
    console.log('\n── badging 自检 ──');
    const pkgLine = lines.find(l => l.startsWith('package:'));
    const launch = lines.find(l => l.includes('launchable-activity'));
    const label = lines.find(l => l.startsWith('application-label:'));
    const sdk = lines.find(l => l.startsWith('sdkVersion'));
    const perm = lines.filter(l => l.startsWith('uses-permission:'));
    if (label) console.log('   ' + label);
    if (sdk) console.log('   ' + sdk);
    if (pkgLine) console.log('   ' + pkgLine.slice(0, 150));
    if (launch) console.log('   ' + launch.slice(0, 150));
    perm.forEach(p => console.log('   ' + p));
  } catch (e) {
    console.log('   (badging 读取失败，非致命)');
  }
  console.log('');
}

/** 递归复制目录。 */
function copyTree(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src)) {
    const s = join(src, e), d = join(dst, e);
    if (statSync(s).isDirectory()) copyTree(s, d);
    else copyFileSync(s, d);
  }
}

main();
