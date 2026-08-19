// 內嵌 build 命令：支援 ./dist/daybrain build、build --binary、test、lint、typecheck

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const projectRoot = process.cwd();

function run(cmd: string, args: string[], label: string): number {
  try {
    execFileSync(cmd, args, { stdio: 'inherit', cwd: projectRoot });
    console.log(`✅ ${label} 完成`);
    return 0;
  } catch (err: unknown) {
    console.error(`❌ ${label} 失敗：${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

export async function execBuild(args: string[]): Promise<number> {
  const binary = args.includes('--binary');
  if (binary) {
    const scriptPath = join(projectRoot, 'scripts', 'build-binary.sh');
    if (!existsSync(scriptPath)) {
      console.error(`❌ 找不到建構腳本：${scriptPath}`);
      return 1;
    }
    console.log('📦 打包 single-file binary（bun）...');
    return run('bash', [scriptPath], 'binary 打包');
  }
  return run('npx', ['tsc', '-p', 'tsconfig.json'], 'TypeScript 編譯');
}

export async function execTest(_args: string[]): Promise<number> {
  console.log('🧪 執行單元測試...');
  return run('node', ['--test', '--import', 'tsx', '--test-concurrency=1', 'src/**/*.test.ts'], '測試');
}

export async function execLint(_args: string[]): Promise<number> {
  console.log('🔍 型別檢查 + ESLint...');
  try {
    execFileSync('npx', ['tsc', '--noEmit', '-p', 'tsconfig.json'], { stdio: 'inherit', cwd: projectRoot });
  } catch (err: unknown) {
    console.error(`❌ 型別檢查失敗：${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  try {
    execFileSync('npx', ['eslint', 'src/**/*.ts'], { stdio: 'inherit', cwd: projectRoot });
  } catch (err: unknown) {
    console.error(`❌ ESLint 失敗：${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  console.log('✅ lint 完成');
  return 0;
}

export async function execTypecheck(_args: string[]): Promise<number> {
  console.log('🔍 型別檢查...');
  return run('npx', ['tsc', '--noEmit', '-p', 'tsconfig.json'], 'typecheck');
}

export default execBuild;
