import { spawn } from 'node:child_process';

const processes = [
  ['web', ['run', 'dev']],
  ['worker', ['run', 'worker:video']]
];
const children = processes.map(([label, args]) => start(label, args));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const child of children) child.kill(signal);
  });
}

function start(label, args) {
  const child = spawn('npm', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32'
  });

  child.stdout.on('data', (chunk) => write(label, chunk));
  child.stderr.on('data', (chunk) => write(label, chunk));
  child.on('exit', (code, signal) => {
    console.log(`[${label}] exited${signal ? ` from ${signal}` : ` with ${code}`}`);
    for (const other of children) {
      if (other !== child) other.kill('SIGTERM');
    }
    if (code && !process.exitCode) process.exitCode = code;
  });
  return child;
}

function write(label, chunk) {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (line) console.log(`[${label}] ${line}`);
  }
}
