import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';

const destination = path.resolve('dist/server/prompts');
await mkdir(destination, { recursive: true });
await cp(path.resolve('prompts'), destination, { recursive: true });
