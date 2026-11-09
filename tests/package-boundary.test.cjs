/**
 * T009 包边界检查脚本回归测试（PK03）
 *
 * 在临时目录内合成 wxapkg 容器，验证检查脚本能通过正常候选结构，
 * 并能拒绝缺少正式文件、内部资料入包、运行时内容损坏和容器损坏。
 * 合成包只用于测试脚本本身，不替代真实构建产物。
 *
 * 运行：node --test tests/package-boundary.test.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-package.cjs');
const {
  collectSourceRuntime,
  EXIT_OK,
  EXIT_USAGE,
  EXIT_CONTAINER,
  EXIT_VIOLATION
} = require(SCRIPT);

function buildWxapkg(files) {
  const normalized = files.map(file => ({
    name: file.name.startsWith('/') ? file.name : `/${file.name}`,
    data: Buffer.from(file.data)
  }));
  const indexLen = normalized.reduce(
    (sum, file) => sum + 4 + Buffer.byteLength(file.name, 'utf8') + 8,
    0
  );
  const infoLen = indexLen + 4;
  const dataLen = normalized.reduce((sum, file) => sum + file.data.length, 0);
  const dataStart = 14 + infoLen;
  const buf = Buffer.alloc(dataStart + dataLen);

  buf[0] = 0xbe;
  buf.writeInt32BE(0, 1);
  buf.writeInt32BE(infoLen, 5);
  buf.writeInt32BE(dataLen, 9);
  buf[13] = 0xed;
  buf.writeInt32BE(normalized.length, 14);

  let pos = 18;
  let dataPos = dataStart;
  for (const file of normalized) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    buf.writeInt32BE(nameBuf.length, pos);
    pos += 4;
    nameBuf.copy(buf, pos);
    pos += nameBuf.length;
    buf.writeInt32BE(dataPos, pos);
    pos += 4;
    buf.writeInt32BE(file.data.length, pos);
    pos += 4;
    file.data.copy(buf, dataPos);
    dataPos += file.data.length;
  }
  return buf;
}

function runtimeFiles() {
  const { expected } = collectSourceRuntime(ROOT);
  return [...expected.keys()].map(name => ({
    name,
    data: fs.readFileSync(path.join(ROOT, name))
  }));
}

function candidateFiles(overrides = {}, extra = []) {
  const files = runtimeFiles().filter(
    file => !Object.prototype.hasOwnProperty.call(overrides, file.name)
  );
  for (const [name, data] of Object.entries(overrides)) {
    files.push({ name, data });
  }
  return files
    .concat(extra)
    .concat([
      {
        name: 'project.config.json',
        data: Buffer.from('{"miniprogramRoot":"","__compileDebugInfo__":{"useSummer":true}}')
      }
    ]);
}

function writePackage(t, files, mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't009-package-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let buf = buildWxapkg(files);
  if (mutate) buf = mutate(buf);
  const packagePath = path.join(dir, 'candidate.wxapkg');
  fs.writeFileSync(packagePath, buf);
  return packagePath;
}

function runCheck(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

test('PK03 正常候选结构通过，且不误判编译产物 project.config.json', t => {
  const pkg = writePackage(t, candidateFiles());
  const result = runCheck(['--package', pkg, '--source', ROOT]);
  assert.equal(result.status, EXIT_OK, result.stdout + result.stderr);
  assert.match(result.stdout, /结果：PASS/);
  assert.match(result.stdout, /INFO 已区分编译产物：project\.config\.json/);
  assert.match(result.stdout, /应含 39 项/);
});

test('PK03 缺少正式页面文件时退出 4', t => {
  const files = candidateFiles().filter(file => file.name !== 'pages/stats/stats.wxml');
  const pkg = writePackage(t, files);
  const result = runCheck(['--package', pkg, '--source', ROOT]);
  assert.equal(result.status, EXIT_VIOLATION);
  assert.match(result.stdout, /缺少正式运行时文件：pages\/stats\/stats\.wxml/);
});

test('PK03 内部资料与实验工程入包时逐项报告并退出 4', t => {
  const extras = [
    { name: 'docs/reviews/001.md', data: '# internal' },
    { name: 'tasks/T009.md', data: '# task' },
    { name: 'roles/zcode-dev.md', data: '# role' },
    { name: 'scripts/check-package.cjs', data: '// script' },
    { name: 'tests/package-boundary.test.cjs', data: '// test' },
    { name: 'pm-reports/T005-review.md', data: '# report' },
    { name: '.worktrees/T009/app.js', data: '// worktree' },
    { name: '.git/config', data: '[core]' },
    { name: '.claude/settings.local.json', data: '{}' },
    { name: '.codex/config.json', data: '{}' },
    { name: 'devtools/media-check/app.js', data: 'App({})' },
    { name: 'devtools/gym-log/app.js', data: 'App({})' },
    { name: 'AGENTS.md', data: '# agents' },
    { name: 'ROADMAP.md', data: '# roadmap' },
    { name: 'WORKFLOW.md', data: '# workflow' },
    { name: '.gitignore', data: 'node_modules/' },
    { name: 'images/README.txt', data: 'icons' }
  ];
  const pkg = writePackage(t, candidateFiles({}, extras));
  const result = runCheck(['--package', pkg, '--source', ROOT]);
  assert.equal(result.status, EXIT_VIOLATION);
  for (const name of [
    'docs/reviews/001.md',
    'tasks/T009.md',
    'roles/zcode-dev.md',
    'scripts/check-package.cjs',
    'tests/package-boundary.test.cjs',
    'pm-reports/T005-review.md',
    '.worktrees/T009/app.js',
    '.git/config',
    '.claude/settings.local.json',
    '.codex/config.json',
    'devtools/media-check/app.js',
    'devtools/gym-log/app.js',
    'AGENTS.md',
    'ROADMAP.md',
    'WORKFLOW.md',
    '.gitignore',
    'images/README.txt'
  ]) {
    assert.match(result.stdout, new RegExp(`内部资料入包：${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }
});

test('PK03 私有配置入包时退出 4，编译生成的同名 project.config.json 保留', t => {
  const extras = [{ name: 'project.private.config.json', data: '{"libVersion":"x"}' }];
  const pkg = writePackage(t, candidateFiles({}, extras));
  const result = runCheck(['--package', pkg, '--source', ROOT]);
  assert.equal(result.status, EXIT_VIOLATION);
  assert.match(result.stdout, /内部资料入包：project\.private\.config\.json/);
  assert.doesNotMatch(result.stdout, /内部资料入包：project\.config\.json/);
});

test('PK03 运行时内容为空时退出 4', t => {
  const pkg = writePackage(t, candidateFiles({ 'app.wxss': '' }));
  const result = runCheck(['--package', pkg, '--source', ROOT]);
  assert.equal(result.status, EXIT_VIOLATION);
  assert.match(result.stdout, /运行时文件为空：app\.wxss/);
});

test('PK03 运行时 JSON 非法时退出 4', t => {
  const pkg = writePackage(t, candidateFiles({ 'pages/index/index.json': '{' }));
  const result = runCheck(['--package', pkg, '--source', ROOT]);
  assert.equal(result.status, EXIT_VIOLATION);
  assert.match(result.stdout, /运行时 JSON 无法解析：pages\/index\/index\.json/);
});

test('PK03 包内 app.json 页面清单与源码不一致时退出 4', t => {
  const pkg = writePackage(t, candidateFiles({ 'app.json': '{"pages":[]}' }));
  const result = runCheck(['--package', pkg, '--source', ROOT]);
  assert.equal(result.status, EXIT_VIOLATION);
  assert.match(result.stdout, /包内 app\.json 页面清单与源码不一致/);
});

test('PK03 图标不是有效 PNG 时退出 4', t => {
  const pkg = writePackage(t, candidateFiles({ 'images/home.png': 'not-a-png' }));
  const result = runCheck(['--package', pkg, '--source', ROOT]);
  assert.equal(result.status, EXIT_VIOLATION);
  assert.match(result.stdout, /图标不是有效 PNG：images\/home\.png/);
});

test('PK03 截断包退出 3', t => {
  const pkg = writePackage(t, candidateFiles(), buf => buf.subarray(0, buf.length - 4));
  const result = runCheck(['--package', pkg, '--source', ROOT]);
  assert.equal(result.status, EXIT_CONTAINER);
  assert.match(result.stderr, /数据区长度与文件不一致/);
});

test('PK03 魔数错误退出 3', t => {
  const pkg = writePackage(t, candidateFiles(), buf => {
    const copy = Buffer.from(buf);
    copy[0] = 0x00;
    return copy;
  });
  const result = runCheck(['--package', pkg, '--source', ROOT]);
  assert.equal(result.status, EXIT_CONTAINER);
  assert.match(result.stderr, /魔数不符/);
});

test('PK03 索引偏移越界退出 3', t => {
  const pkg = writePackage(t, candidateFiles(), buf => {
    const copy = Buffer.from(buf);
    const nameLen = copy.readInt32BE(18);
    const offsetPos = 18 + 4 + nameLen;
    copy.writeInt32BE(0x7fffffff, offsetPos);
    return copy;
  });
  const result = runCheck(['--package', pkg, '--source', ROOT]);
  assert.equal(result.status, EXIT_CONTAINER);
  assert.match(result.stderr, /第 1 条越界/);
});

test('PK03 参数缺失或包不存在时退出 2', t => {
  const missingArgs = runCheck(['--source', ROOT]);
  assert.equal(missingArgs.status, EXIT_USAGE);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't009-package-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const missingPackage = runCheck([
    '--package', path.join(dir, 'absent.wxapkg'),
    '--source', ROOT
  ]);
  assert.equal(missingPackage.status, EXIT_USAGE);
  assert.match(missingPackage.stderr, /包文件不存在/);
});

test('PK03 --json 输出包含检查结果与违规项', t => {
  const extras = [{ name: 'docs/note.md', data: '# note' }];
  const pkg = writePackage(t, candidateFiles({}, extras));
  const result = runCheck(['--package', pkg, '--source', ROOT, '--json']);
  assert.equal(result.status, EXIT_VIOLATION);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.entryCount, 41);
  assert.ok(parsed.violations.some(item => item.includes('docs/note.md')));
});
