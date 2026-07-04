import { spawn } from 'node:child_process';
import path from 'node:path';

const sandboxEnvPath = process.env.SANDBOX_ENV_PATH || '.env.sandbox.example';
const nodeMajor = major(process.version);
if (nodeMajor < 20 || nodeMajor >= 24) {
  console.error(`Node.js ${process.version} is not supported for sandbox checks. Use Node.js 20, 21, 22, or 23.`);
  process.exit(1);
}

const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('npm_') && name !== 'NODE' && name !== 'INIT_CWD')
);
const env = {
  ...baseEnv,
  DOTENV_CONFIG_PATH: path.resolve(process.cwd(), sandboxEnvPath),
  NODE_ENV: 'test',
  PATH: `${path.dirname(process.execPath)}${path.delimiter}${sanitizedPath()}`
};

const steps = [
  ['doctor', ['node', ['scripts/doctor.mjs']]],
  ['check', ['npm', ['run', 'check']]],
  ['test:app', ['node', ['test/app.test.js']]],
  ['test:domain', ['node', ['test/domain.test.js']]],
  ['test:ocr', ['node', ['test/ocr.test.js']]],
  ['test:stream-recorder', ['node', ['test/stream-recorder.test.js']]]
];

for (const [label, command] of steps) {
  const [bin, args] = command;
  console.log(`\n== ${label} ==`);
  await run(bin, args);
}

console.log('\nSandbox checks passed.');

function run(bin, args, runEnv = env) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: runEnv,
      stdio: 'inherit',
      shell: process.platform === 'win32'
    });
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${bin} ${args.join(' ')} failed${signal ? ` from ${signal}` : ` with ${code}`}`));
    });
  });
}

function major(version) {
  const match = /^v?(\d+)/.exec(version);
  return match ? Number(match[1]) : 0;
}

function sanitizedPath() {
  return String(process.env.PATH || '')
    .split(path.delimiter)
    .filter((entry) => entry && !entry.endsWith('/node_modules/.bin') && !entry.includes('/node-gyp-bin'))
    .join(path.delimiter);
}
