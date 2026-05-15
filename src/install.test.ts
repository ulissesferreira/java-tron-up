import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  JAVA_TRON_DEFAULT_FULL_NODE,
  JAVA_TRON_DEFAULT_JAVA_RUNTIME,
  cleanJavaTronCache,
  getJavaTronCacheDirectory,
  installJavaRuntime,
  installJavaTron,
  parseJavaTronInstallCliOptions,
  readJavaTronInstallOptionsFromPackageJson,
  type JavaTronInstallDependencies,
} from './install';

describe('java-tron-up installer', () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { force: true, recursive: true });
    }
    tempDirs = [];
  });

  it('pins a java-tron release and Java runtime', () => {
    assert.equal(JAVA_TRON_DEFAULT_FULL_NODE.version, 'GreatVoyage-v4.8.1');
    assert.equal(
      JAVA_TRON_DEFAULT_FULL_NODE.platforms['darwin-arm64']?.checksum,
      '694431860ee76fc986ed495f9ec19f29ed3bd752a394386e7b3b9886b2292f59',
    );
    assert.equal(
      JAVA_TRON_DEFAULT_JAVA_RUNTIME.platforms['linux-x64']?.checksum,
      '39abf1dc6798b5f6b8e9dca4e78994da316a3f990e444c2c483ea04f7f882cf2',
    );
  });

  it('uses the local MetaMask cache when Yarn global cache is disabled', () => {
    const cwd = createTempDir();
    writeFileSync(join(cwd, '.yarnrc.yml'), 'enableGlobalCache: false\n');

    assert.equal(
      getJavaTronCacheDirectory({ cwd }),
      join(cwd, '.metamask', 'cache'),
    );
  });

  it('uses the shared MetaMask cache when Yarn global cache is enabled', () => {
    const cwd = createTempDir();
    const homeDirectory = createTempDir();
    writeFileSync(join(cwd, '.yarnrc.yml'), 'enableGlobalCache: true\n');

    assert.equal(
      getJavaTronCacheDirectory({ cwd, homeDirectory }),
      join(homeDirectory, '.cache', 'metamask'),
    );
  });

  it('reads pinned installer options from package.json', () => {
    const cwd = createTempDir();
    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify({
        javaTronUp: {
          fullNode: {
            platforms: {
              'linux-x64': {
                checksum:
                  '0e67b2fe75d7077750e73c4fa20725c6e9824657275d96be256ae5da681f9945',
                url: 'https://example.test/FullNode.jar',
              },
            },
            version: 'test-fullnode',
          },
          javaRuntime: {
            platforms: {
              'linux-x64': {
                checksum:
                  '39abf1dc6798b5f6b8e9dca4e78994da316a3f990e444c2c483ea04f7f882cf2',
                url: 'https://example.test/java-runtime.tar.gz',
              },
            },
            version: 'test-java',
          },
        },
      }),
    );

    assert.deepEqual(readJavaTronInstallOptionsFromPackageJson({ cwd }), {
      fullNode: {
        platforms: {
          'linux-x64': {
            checksum:
              '0e67b2fe75d7077750e73c4fa20725c6e9824657275d96be256ae5da681f9945',
            url: 'https://example.test/FullNode.jar',
          },
        },
        version: 'test-fullnode',
      },
      javaRuntime: {
        platforms: {
          'linux-x64': {
            checksum:
              '39abf1dc6798b5f6b8e9dca4e78994da316a3f990e444c2c483ea04f7f882cf2',
            url: 'https://example.test/java-runtime.tar.gz',
          },
        },
        version: 'test-java',
      },
    });
  });

  it('parses installer CLI options', () => {
    assert.deepEqual(
      parseJavaTronInstallCliOptions([
        '--cache-directory',
        '/tmp/cache',
        '--bin-directory',
        '/tmp/bin',
        '--full-node-url',
        'https://example.test/FullNode.jar',
        '--full-node-checksum',
        'fullnode-hash',
        '--java-runtime-url',
        'https://example.test/java-runtime.tar.gz',
        '--java-runtime-checksum',
        'java-hash',
      ]),
      {
        binDirectory: '/tmp/bin',
        cacheDirectory: '/tmp/cache',
        fullNode: {
          platforms: {
            current: {
              checksum: 'fullnode-hash',
              url: 'https://example.test/FullNode.jar',
            },
          },
        },
        javaRuntime: {
          platforms: {
            current: {
              checksum: 'java-hash',
              url: 'https://example.test/java-runtime.tar.gz',
            },
          },
        },
      },
    );
  });

  it('downloads, verifies, caches, and installs java-tron wrappers', async () => {
    const cwd = createTempDir();
    const cacheDirectory = join(cwd, '.metamask', 'cache');
    const binDirectory = join(cwd, 'node_modules', '.bin');
    const downloads: { destination: string; url: string }[] = [];
    const fullNodeContent = 'fake FullNode jar';
    const javaRuntimeContent = 'fake Java runtime';
    const dependencies = createDependencies({
      downloads,
      fullNodeContent,
      javaRuntimeContent,
    });

    const result = await installJavaTron(
      {
        binDirectory,
        cacheDirectory,
        cwd,
        fullNode: createFullNodeConfig(fullNodeContent),
        javaRuntime: createJavaRuntimeConfig(javaRuntimeContent),
        platform: 'linux-x64',
      },
      dependencies,
    );

    assert.equal(result.cacheHit, false);
    assert.equal(result.version, 'test-fullnode');
    assert.equal(result.binaryPath, join(binDirectory, 'java-tron'));
    assert.ok(result.fullNodeJar.endsWith('/FullNode.jar'));
    assert.ok(result.javaBinary.endsWith('/bin/java'));
    assert.equal(readFileSync(result.fullNodeJar, 'utf8'), fullNodeContent);
    assert.deepEqual(
      downloads.map(({ url }) => url),
      [
        'https://example.test/java-runtime.tar.gz',
        'https://example.test/FullNode.jar',
      ],
    );

    const wrapperOutput = execFileSync(result.binaryPath, ['--version'], {
      encoding: 'utf8',
    });
    assert.match(wrapperOutput, /^java -jar .*FullNode\.jar --version\n$/u);
  });

  it('reuses cached fullnode and Java artifacts without downloading again', async () => {
    const cwd = createTempDir();
    const cacheDirectory = join(cwd, '.metamask', 'cache');
    const binDirectory = join(cwd, 'node_modules', '.bin');
    const fullNodeContent = 'cached FullNode jar';
    const javaRuntimeContent = 'cached Java runtime';
    const fullNode = createFullNodeConfig(fullNodeContent);
    const javaRuntime = createJavaRuntimeConfig(javaRuntimeContent);

    await installJavaTron(
      { binDirectory, cacheDirectory, cwd, fullNode, javaRuntime, platform: 'linux-x64' },
      createDependencies({ fullNodeContent, javaRuntimeContent }),
    );

    const result = await installJavaTron(
      { binDirectory, cacheDirectory, cwd, fullNode, javaRuntime, platform: 'linux-x64' },
      {
        downloadFile: async () => {
          throw new Error('cache miss');
        },
      },
    );

    assert.equal(result.cacheHit, true);
  });

  it('finds Java in nested runtime archive roots', async () => {
    const cwd = createTempDir();
    const javaRuntimeContent = 'nested runtime archive';

    const javaBinary = await installJavaRuntime(
      {
        cacheDirectory: join(cwd, '.metamask', 'cache'),
        javaRuntime: createJavaRuntimeConfig(javaRuntimeContent),
        platform: 'linux-x64',
      },
      createDependencies({
        fullNodeContent: 'unused',
        javaRuntimeContent,
        javaRoot: 'nested/zulu',
      }),
    );

    assert.ok(javaBinary.endsWith('/nested/zulu/bin/java'));
    assert.equal(existsSync(javaBinary), true);
  });

  it('cleans only the java-tron-up cache namespace', async () => {
    const cwd = createTempDir();
    const cacheDirectory = join(cwd, '.metamask', 'cache');
    await mkdir(join(cacheDirectory, 'java-tron-up', 'old'), {
      recursive: true,
    });
    await mkdir(join(cacheDirectory, 'foundryup', 'kept'), {
      recursive: true,
    });

    await cleanJavaTronCache({ cacheDirectory, cwd });

    assert.equal(existsSync(join(cacheDirectory, 'java-tron-up')), false);
    assert.equal(existsSync(join(cacheDirectory, 'foundryup', 'kept')), true);
  });

  function createTempDir(): string {
    const tempDir = mkdtempSync(join(tmpdir(), 'java-tron-up-test-'));
    tempDirs.push(tempDir);
    return tempDir;
  }
});

function createDependencies({
  downloads = [],
  fullNodeContent,
  javaRoot = 'zulu',
  javaRuntimeContent,
}: {
  downloads?: { destination: string; url: string }[];
  fullNodeContent: string;
  javaRoot?: string;
  javaRuntimeContent: string;
}): JavaTronInstallDependencies {
  return {
    downloadFile: async (url, destination) => {
      downloads.push({ destination, url });
      await writeFile(
        destination,
        url.endsWith('FullNode.jar') ? fullNodeContent : javaRuntimeContent,
      );
    },
    extractArchive: async (_archivePath, destination) => {
      const binDirectory = join(destination, javaRoot, 'bin');
      await mkdir(binDirectory, { recursive: true });
      await writeExecutable(join(binDirectory, 'java'), 'java');
    },
  };
}

function createFullNodeConfig(content: string) {
  return {
    platforms: {
      'linux-x64': {
        checksum: sha256(content),
        url: 'https://example.test/FullNode.jar',
      },
    },
    version: 'test-fullnode',
  };
}

function createJavaRuntimeConfig(content: string) {
  return {
    platforms: {
      'linux-x64': {
        checksum: sha256(content),
        url: 'https://example.test/java-runtime.tar.gz',
      },
    },
    version: 'test-java',
  };
}

async function writeExecutable(path: string, name: string): Promise<void> {
  await writeFile(
    path,
    `#!/usr/bin/env node\nconsole.log(${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' '));\n`,
    { mode: 0o755 },
  );
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

