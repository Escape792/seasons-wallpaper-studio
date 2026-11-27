#!/usr/bin/env node
/* ============================================================
   通过 GitHub API 推送提交（绕过 git push 的 TLS 问题）
   用法：node tools/gh-push.mjs <owner> <repo> [branch] [message]
   ============================================================ */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const OWNER = process.argv[2] || 'Escape792';
const REPO = process.argv[3] || 'seasons-wallpaper-studio';
const BRANCH = process.argv[4] || 'master';
const MSG = process.argv[5] || 'update';

const GH = 'C:/Program Files/GitHub CLI/gh.exe';
if (!statSync(GH, { throwIfNoEntry: false })) { console.error('gh 不存在'); process.exit(1); }

function gh(args, input) {
  const opt = { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 };
  if (input !== undefined) {
    opt.input = input;
  }
  return execFileSync(GH, args, opt);
}
function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
}
function apiGet(path) {
  return JSON.parse(gh(['api', path]));
}
function apiPost(path, body) {
  return JSON.parse(gh(['api', '--method', 'POST', path, '--input', '-'], JSON.stringify(body)));
}
function apiPatch(path, body) {
  return JSON.parse(gh(['api', '--method', 'PATCH', path, '--input', '-'], JSON.stringify(body)));
}

/* ---- 1. 收集变更：本地 HEAD 树 vs 远端树 ---- */
const localFiles = git(['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').map(s => s.trim()).filter(Boolean);
const baseRef = apiGet(`repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
const baseSha = baseRef.object.sha;
const baseCommit = apiGet(`repos/${OWNER}/${REPO}/git/commits/${baseSha}`);
const baseTreeSha = baseCommit.tree.sha;
const remoteTree = apiGet(`repos/${OWNER}/${REPO}/git/trees/${baseTreeSha}?recursive=1`);

const remoteMap = new Map();
for (const e of remoteTree.tree) {
  if (e.type === 'blob') remoteMap.set(e.path, e);
}

/* 本地每个文件算 sha（写入 .git 对象库） */
const localMap = new Map();
for (const f of localFiles) {
  const sha = git(['hash-object', '-w', '--', f]).trim();
  localMap.set(f, sha);
}

/* 需要上传：本地有且 sha 不同 或 远端没有 */
const toUpload = [];
for (const [f, sha] of localMap) {
  const r = remoteMap.get(f);
  if (!r || r.sha !== sha) toUpload.push(f);
}
/* 需要删除：远端有本地没有 */
const localSet = new Set(localFiles);

console.log(`upload ${toUpload.length}, total ${localFiles.length}`);

/* ---- 2. 通过 API 创建 blob（本地 git blob 不存在于 GitHub，必须重新上传）---- */
import { readFileSync } from 'node:fs';
const uploaded = new Map();
let done = 0;
for (const f of toUpload) {
  const b64 = readFileSync(join(ROOT, f)).toString('base64');
  const res = apiPost(`repos/${OWNER}/${REPO}/git/blobs`, { content: b64, encoding: 'base64' });
  uploaded.set(f, res.sha);
  done++;
  if (done % 10 === 0) console.log(`  blobs ${done}/${toUpload.length}`);
}
console.log('blobs uploaded:', uploaded.size);

/* ---- 3. 组装完整 tree（未变更文件沿用远端 sha，变更文件用新 sha）---- */
const tree = [];
for (const [f, sha] of localMap) {
  const r = remoteMap.get(f);
  const useSha = uploaded.has(f) ? uploaded.get(f) : sha;
  tree.push({ path: f, mode: r ? r.mode : '100644', type: 'blob', sha: useSha });
}
console.log('tree entries:', tree.length);

/* ---- 4. 创建 tree ---- */
const treeRes = apiPost(`repos/${OWNER}/${REPO}/git/trees`, { tree });
console.log('new tree:', treeRes.sha);

/* ---- 5. 创建 commit ---- */
const commitRes = apiPost(`repos/${OWNER}/${REPO}/git/commits`, {
  message: MSG, tree: treeRes.sha, parents: [baseSha]
});
console.log('new commit:', commitRes.sha);

/* ---- 6. 更新 ref ---- */
apiPatch(`repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { sha: commitRes.sha, force: false });
console.log('PUSHED ->', `https://github.com/${OWNER}/${REPO}/commit/${commitRes.sha}`);
