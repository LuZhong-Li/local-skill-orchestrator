/** bench 命令行参数解析。 */
import { join } from 'node:path';
import { DEFAULT_SEED } from './fixture.mjs';
import { FORMS } from './measure.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const DEFAULT_OUT_DIR = join(ROOT, 'build', 'bench');

export function parseArgs(argv) {
  const options = {
    sizes: [100],
    form: 'source',
    runs: null,
    seed: DEFAULT_SEED,
    kernel: null,
    outDir: DEFAULT_OUT_DIR,
    root: null,
    dryRun: false,
    profile: null,
    load: '本机空闲，开机后尽快跑',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`选项 ${token} 缺少取值`);
      return argv[i];
    };
    if (token === '--n') {
      const values = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        values.push(argv[i + 1]);
        i += 1;
      }
      options.sizes = values
        .join(',')
        .split(/[,\s]+/)
        .filter((part) => part !== '')
        .map((part) => Number(part));
      if (options.sizes.length === 0) throw new Error('选项 --n 缺少取值');
    } else if (token === '--form') options.form = next();
    else if (token === '--runs') options.runs = Number(next());
    else if (token === '--seed') options.seed = Number(next());
    else if (token === '--kernel') options.kernel = next();
    else if (token === '--out') options.outDir = next();
    else if (token === '--root') options.root = next();
    else if (token === '--dry-run') options.dryRun = true;
    else if (token === '--no-profile') options.profile = false;
    else if (token === '--profile') options.profile = true;
    else if (token === '--load') options.load = next();
    else throw new Error(`未知选项：${token}`);
  }
  if (!FORMS.includes(options.form) && options.form !== 'both') {
    throw new Error(`--form 只支持 ${FORMS.join(' / ')} / both：${options.form}`);
  }
  if (options.sizes.length === 0 || options.sizes.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error(`--n 必须是正整数（可给多个）：${String(options.sizes)}`);
  }
  if (!Number.isInteger(options.seed))
    throw new Error(`--seed 必须是整数：${String(options.seed)}`);
  return options;
}
