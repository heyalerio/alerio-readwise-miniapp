import { constants } from 'node:fs';
import { access, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const envPath = path.join(root, '.env');
const examplePath = path.join(root, '.env.example');

await ensureEnv();
await mkdir(path.join(root, 'data', 'media'), { recursive: true });
await mkdir(path.join(root, 'data', 'rtmp-recordings'), { recursive: true });

console.log('Setup complete.');
console.log('');
console.log('Next steps:');
console.log('1. Edit .env with your Mentra/Public URL/secrets.');
console.log('2. Run npm run doctor.');
console.log('3. Run npm run dev:all.');

async function ensureEnv() {
  if (await exists(envPath)) {
    console.log('.env already exists; leaving it unchanged.');
    return;
  }
  await copyFile(examplePath, envPath);
  console.log('Created .env from .env.example.');
}

async function exists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
