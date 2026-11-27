import { spawn } from 'node:child_process';

const scenes = ['valley', 'path', 'court', 'sea', 'forest'];
const seasons = ['spring', 'summer', 'autumn', 'winter'];
const mode = process.argv[2] || 'landscape';

const jobs = [];
if (mode === 'portrait') {
  for (const se of seasons) jobs.push({ s: 'valley', se, aspect: '9:16', w: '1080', h: '1920', out: `out/portrait/valley-${se}.mp4` });
} else {
  for (const s of scenes) for (const se of seasons) jobs.push({ s, se, aspect: '16:9', w: '1920', h: '1080', out: `out/${s}-${se}.mp4` });
}

for (const j of jobs) {
  console.log('\n===== ' + j.out + ' =====');
  await new Promise((res, rej) => {
    const p = spawn(process.execPath, ['tools/render.mjs',
      '--scene', j.s, '--season', j.se, '--style', 'real',
      '--aspect', j.aspect, '--width', j.w, '--height', j.h,
      '--fps', '30', '--seconds', '12', '--out', j.out
    ], { stdio: 'inherit', shell: true });
    p.on('close', c => c === 0 ? res() : rej(new Error('fail ' + j.out)));
  });
}
console.log('\nALL DONE');
