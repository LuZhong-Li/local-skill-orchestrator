export function printSmokeReport(checks, diagnostics, stderr) {
  for (const item of checks) {
    console.log(
      `${item.ok ? '✔' : '✖'} ${item.name}${item.detail === '' ? '' : `（${item.detail}）`}`,
    );
  }
  if (diagnostics.length > 0) {
    console.log('--- 诊断 ---');
    for (const line of diagnostics) console.log(line);
  }
  if (stderr.trim() !== '') {
    console.log('--- 主进程诊断输出 ---');
    console.log(stderr.trim().split('\n').slice(0, 10).join('\n'));
  }
  const failed = checks.filter((item) => !item.ok);
  console.log(`\n界面冒烟：${checks.length - failed.length}/${checks.length} 通过`);
  process.exit(failed.length === 0 ? 0 : 1);
}
