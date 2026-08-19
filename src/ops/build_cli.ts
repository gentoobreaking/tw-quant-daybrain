// 內嵌 build 命令：支援 ./dist/daybrain build 與 ./dist/daybrain build --binary

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export async function execBuild(args: string[]): Promise<number> {
  const binary = args.includes('--binary');
  const projectRoot = process.cwd();

  if (binary) {
    const scriptPath = join(projectRoot, 'scripts', 'build-binary.sh');
    if (!existsSync(scriptPath)) {
      console.error(`❌ 找不到建構腳本：${scriptPath}`);
      return 1;
    }
    console.log('📦 打包 single-file binary（bun）...');
    try {
      execFileSync('bash', [scriptPath], { stdio: 'inherit', cwd: projectRoot });
      console.log('✅ binary 打包完成：dist/daybrain');
      return 0;
    } catch (err) {
      console.error(`❌ 打包失敗：${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  console.log('📝 編譯 TypeScript → dist/...');
  try {
    execFileSync('npx', ['tsc', '-p', 'tsconfig.json'], { stdio: 'inherit', cwd: projectRoot });
    console.log('✅ TypeScript 編譯完成：dist/');
    return 0;
  } catch (err) {
    console.error(`❌ 編譯失敗：${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

export default execBuild;
