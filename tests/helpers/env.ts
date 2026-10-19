import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** 将 HOME / LOCALAPPDATA 指向临时目录，避免 e2e 读取真实宿主根。 */
export function isolateHostEnvironment(root: string): () => void {
  const home = join(root, 'home');
  const local = join(root, 'local');
  mkdirSync(home, { recursive: true });
  mkdirSync(local, { recursive: true });
  const previous = {
    HOME: process.env['HOME'],
    USERPROFILE: process.env['USERPROFILE'],
    LOCALAPPDATA: process.env['LOCALAPPDATA'],
  };
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  process.env['LOCALAPPDATA'] = local;
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
