#!/usr/bin/env node
/**
 * 正式包边界检查（T009）
 *
 * 直接读取开发者工具产出的 wxapkg 二进制索引与数据区，核对正式入口是否完整、
 * 内部资料与本机配置是否入包。不调用开发者工具，也不生成替代包。
 *
 * 用法：
 *   node scripts/check-package.cjs --package <wxapkg 绝对路径> --source <源码根目录>
 *   node scripts/check-package.cjs --package <...> --source <...> --json
 *
 * 退出码：
 *   0  通过
 *   2  参数、文件或源码目录错误
 *   3  wxapkg 容器损坏（魔数、长度、索引越界或截断）
 *   4  包内容不合规（缺少正式入口、运行时内容为空或非法、含内部资料）
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const WXAPKG_MAGIC = 0xbe;
const WXAPKG_MARKER = 0xed;
const HEADER_SIZE = 18;

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_CONTAINER = 3;
const EXIT_VIOLATION = 4;

// 内部资料、协作目录与本机配置：任务 T009 PK01 的排除清单。
const FORBIDDEN_DIRS = [
  'docs',
  'tasks',
  'roles',
  'scripts',
  'tests',
  'pm-reports',
  '.worktrees',
  '.git',
  '.claude',
  '.codex',
  'devtools/media-check',
  'devtools/gym-log'
];

const FORBIDDEN_FILES = [
  'agents.md',
  'roadmap.md',
  'workflow.md',
  '.gitignore',
  'project.private.config.json',
  'images/readme.txt'
];

// 编译产物可能出现的顶层文件：与源码私有配置区分，不按同名误判。
const GENERATED_TOP_LEVEL_FILES = ['project.config.json'];

class WxapkgError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WxapkgError';
  }
}

function readInt32(buf, offset, what) {
  if (offset + 4 > buf.length) {
    throw new WxapkgError(`${what} 读取越界（offset=${offset}）`);
  }
  return buf.readInt32BE(offset);
}

/**
 * 解析 wxapkg 容器。
 *
 * 头部布局（与开发者工具 packFileMap 一致）：
 *   byte 0       0xBE
 *   byte 5..8    infoLen（含文件数字段，数据区起点 = 14 + infoLen）
 *   byte 9..12   dataLen
 *   byte 13      0xED
 *   byte 14..17  文件数
 *   byte 18..    索引：nameLen + name + offset + size；offset 为文件内绝对偏移。
 */
function parseWxapkg(filePath) {
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (err) {
    throw new WxapkgError(`无法读取包文件：${err.message}`);
  }

  if (buf.length < HEADER_SIZE) {
    throw new WxapkgError(`文件过短，不是完整 wxapkg（${buf.length} 字节）`);
  }
  if (buf[0] !== WXAPKG_MAGIC) {
    throw new WxapkgError(`魔数不符：首字节 0x${buf[0].toString(16)}，应为 0xbe`);
  }
  if (buf[13] !== WXAPKG_MARKER) {
    throw new WxapkgError(`标记字节不符：第 14 字节 0x${buf[13].toString(16)}，应为 0xed`);
  }

  const infoLen = readInt32(buf, 5, 'infoLen');
  const dataLen = readInt32(buf, 9, 'dataLen');
  const fileCount = readInt32(buf, 14, 'fileCount');

  if (infoLen < 4 || dataLen < 0 || fileCount < 0) {
    throw new WxapkgError(`头部长度非法：infoLen=${infoLen} dataLen=${dataLen} fileCount=${fileCount}`);
  }

  const dataStart = 14 + infoLen;
  const dataEnd = dataStart + dataLen;
  if (dataStart < HEADER_SIZE || dataStart > buf.length) {
    throw new WxapkgError(`索引长度越界：dataStart=${dataStart}，文件 ${buf.length} 字节`);
  }
  if (dataEnd !== buf.length) {
    throw new WxapkgError(
      `数据区长度与文件不一致：dataStart=${dataStart} dataLen=${dataLen} ` +
      `dataEnd=${dataEnd} fileSize=${buf.length}（截断或多出字节）`
    );
  }

  let pos = HEADER_SIZE;
  const entries = [];
  const seen = new Set();
  for (let i = 0; i < fileCount; i += 1) {
    if (pos + 4 > dataStart) {
      throw new WxapkgError(`索引在声明文件数前结束（已读 ${i}/${fileCount} 条）`);
    }
    const nameLen = readInt32(buf, pos, `第 ${i + 1} 条 nameLen`);
    pos += 4;
    if (nameLen <= 0 || pos + nameLen + 8 > dataStart) {
      throw new WxapkgError(`第 ${i + 1} 条文件名长度越界：nameLen=${nameLen}`);
    }
    const rawName = buf.subarray(pos, pos + nameLen).toString('utf8');
    pos += nameLen;
    if (!rawName || rawName.includes('\u0000')) {
      throw new WxapkgError(`第 ${i + 1} 条文件名为空或含 NUL`);
    }
    const offset = readInt32(buf, pos, `第 ${i + 1} 条 offset`);
    pos += 4;
    const size = readInt32(buf, pos, `第 ${i + 1} 条 size`);
    pos += 4;

    if (offset < dataStart || size < 0 || offset + size > dataEnd) {
      throw new WxapkgError(
        `第 ${i + 1} 条越界：${rawName} offset=${offset} size=${size}`
      );
    }
    if (seen.has(rawName)) {
      throw new WxapkgError(`索引出现重复条目：${rawName}`);
    }
    seen.add(rawName);
    entries.push({ name: rawName, offset, size });
  }
  if (pos !== dataStart) {
    throw new WxapkgError(`索引结束位置 ${pos} 与数据区起点 ${dataStart} 不一致`);
  }

  return { filePath, buffer: buf, entries, dataStart, dataLen };
}

function normalizeEntryName(name) {
  return name.replace(/\\/g, '/').replace(/^\/+/, '');
}

function isForbidden(entryName) {
  const lower = normalizeEntryName(entryName).toLowerCase();
  if (FORBIDDEN_FILES.includes(lower)) return true;
  return FORBIDDEN_DIRS.some(dir => lower === dir || lower.startsWith(`${dir}/`));
}

function addExpected(map, name, kind) {
  const normalized = normalizeEntryName(name);
  if (!normalized) return;
  map.set(normalized, kind);
}

/**
 * 从源码推导正式运行时应存在的条目。
 * 只使用 app.json、sitemap 与 utils 的实际文件，不使用扩展名白名单。
 */
function collectSourceRuntime(sourceRoot) {
  const appJsonPath = path.join(sourceRoot, 'app.json');
  const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  const expected = new Map();

  addExpected(expected, 'app.js', 'code');
  addExpected(expected, 'app.json', 'json');
  addExpected(expected, 'app.wxss', 'wxss');
  addExpected(expected, appJson.sitemapLocation || 'sitemap.json', 'json');

  for (const page of appJson.pages || []) {
    for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
      addExpected(expected, `${page}${ext}`, ext === '.json' ? 'json' : 'code');
    }
  }

  const tabList = (appJson.tabBar && appJson.tabBar.list) || [];
  for (const item of tabList) {
    if (item.iconPath) addExpected(expected, item.iconPath, 'png');
    if (item.selectedIconPath) addExpected(expected, item.selectedIconPath, 'png');
  }

  const utilsDir = path.join(sourceRoot, 'utils');
  if (fs.existsSync(utilsDir)) {
    for (const file of fs.readdirSync(utilsDir, { withFileTypes: true })) {
      if (file.isFile() && file.name.endsWith('.js')) {
        addExpected(expected, `utils/${file.name}`, 'code');
      }
    }
  }

  return { appJson, expected };
}

function isNonEmpty(data) {
  return data.length > 0 && data.toString('utf8').trim().length > 0;
}

function checkPackage(options) {
  const packagePath = path.resolve(options.packagePath);
  const sourceRoot = path.resolve(options.sourceRoot);

  if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
    const err = new Error(`源码目录不存在：${sourceRoot}`);
    err.code = EXIT_USAGE;
    throw err;
  }
  if (!fs.existsSync(packagePath) || !fs.statSync(packagePath).isFile()) {
    const err = new Error(`包文件不存在：${packagePath}`);
    err.code = EXIT_USAGE;
    throw err;
  }

  const { appJson: sourceAppJson, expected } = collectSourceRuntime(sourceRoot);
  const container = parseWxapkg(packagePath);
  const violations = [];
  const allowed = [];

  const entryNames = new Set();
  for (const entry of container.entries) {
    const name = normalizeEntryName(entry.name);
    entryNames.add(name);
    if (isForbidden(name)) {
      violations.push(`内部资料入包：${name}`);
    }
    if (GENERATED_TOP_LEVEL_FILES.includes(name.toLowerCase())) {
      allowed.push(`已区分编译产物：${name}`);
    }
  }

  for (const [name, kind] of expected) {
    if (!entryNames.has(name)) {
      violations.push(`缺少正式运行时文件：${name}`);
      continue;
    }
    const entry = container.entries.find(item => normalizeEntryName(item.name) === name);
    const data = container.buffer.subarray(entry.offset, entry.offset + entry.size);
    if (!isNonEmpty(data)) {
      violations.push(`运行时文件为空：${name}`);
      continue;
    }
    if (kind === 'json') {
      let parsed;
      try {
        parsed = JSON.parse(data.toString('utf8'));
      } catch (err) {
        violations.push(`运行时 JSON 无法解析：${name}（${err.message}）`);
        continue;
      }
      if (name === 'app.json') {
        const pages = JSON.stringify(parsed.pages || []);
        const sourcePages = JSON.stringify(sourceAppJson.pages || []);
        if (pages !== sourcePages) {
          violations.push(`包内 app.json 页面清单与源码不一致：${pages} != ${sourcePages}`);
        }
      }
    } else if (kind === 'png') {
      const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      if (data.length < signature.length || !data.subarray(0, signature.length).equals(signature)) {
        violations.push(`图标不是有效 PNG：${name}`);
      }
    }
  }

  return {
    ok: violations.length === 0,
    packagePath,
    sourceRoot,
    entryCount: container.entries.length,
    expectedCount: expected.size,
    expectedNames: [...expected.keys()],
    violations,
    allowed,
    bytes: container.buffer.length
  };
}

function parseArgs(argv) {
  const options = { packagePath: null, sourceRoot: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--package') {
      options.packagePath = argv[i + 1];
      i += 1;
    } else if (arg === '--source') {
      options.sourceRoot = argv[i + 1];
      i += 1;
    } else if (arg === '--json') {
      options.json = true;
    } else {
      return { error: `未知参数：${arg}` };
    }
  }
  if (!options.packagePath || !options.sourceRoot) {
    return { error: '必须同时提供 --package 与 --source' };
  }
  return options;
}

function usage() {
  console.error('用法：node scripts/check-package.cjs --package <wxapkg 路径> --source <源码根目录> [--json]');
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.error) {
    console.error(options.error);
    usage();
    return EXIT_USAGE;
  }

  let result;
  try {
    result = checkPackage(options);
  } catch (err) {
    if (options.json) {
      console.log(JSON.stringify({ ok: false, error: err.message, exitCode: err instanceof WxapkgError ? EXIT_CONTAINER : EXIT_USAGE }));
    } else {
      console.error(`FAIL ${err instanceof WxapkgError ? '容器损坏' : '检查失败'}：${err.message}`);
    }
    if (err instanceof WxapkgError) return EXIT_CONTAINER;
    if (err.code === EXIT_USAGE) return EXIT_USAGE;
    return EXIT_USAGE;
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`包：${result.packagePath}`);
    console.log(`源码：${result.sourceRoot}`);
    console.log(`条目：${result.entryCount}，数据区 ${result.bytes} 字节`);
    for (const note of result.allowed) console.log(`INFO ${note}`);
    for (const violation of result.violations) console.log(`FAIL ${violation}`);
    console.log(
      `正式运行时：应含 ${result.expectedCount} 项，${result.expectedCount - result.violations.filter(v => v.startsWith('缺少')).length} 项合格`
    );
    console.log(result.ok ? '结果：PASS' : '结果：FAIL');
  }
  return result.ok ? EXIT_OK : EXIT_VIOLATION;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  parseWxapkg,
  checkPackage,
  collectSourceRuntime,
  isForbidden,
  normalizeEntryName,
  WxapkgError,
  EXIT_OK,
  EXIT_USAGE,
  EXIT_CONTAINER,
  EXIT_VIOLATION
};
