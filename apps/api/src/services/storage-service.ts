import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, realpath, rm, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream';
import { promisify } from 'node:util';

const streamPipeline = promisify(pipeline);

export interface StorageSaveResult {
  storagePath: string;
  sizeBytes: number;
  checksum: string;
}

export class StorageService {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = resolve(
      baseDir || process.env['MINI_CI_ARTIFACTS_DIR'] || join(process.cwd(), '.artifacts'),
    );
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  private assertWithinBase(target: string, base: string = this.baseDir): void {
    const path = relative(base, target);
    if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
      throw new Error('Access denied: path is outside storage directory');
    }
  }

  private async resolveArtifactPath(storagePath: string): Promise<string> {
    const resolvedPath = resolve(storagePath);
    this.assertWithinBase(resolvedPath);
    const canonicalPath = await realpath(resolvedPath);
    this.assertWithinBase(canonicalPath, await realpath(this.baseDir));
    return canonicalPath;
  }

  async saveArtifact(
    workflowRunId: string,
    jobId: string,
    filename: string,
    source: NodeJS.ReadableStream | Buffer,
  ): Promise<StorageSaveResult> {
    for (const id of [workflowRunId, jobId]) {
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
        throw new Error('Invalid artifact storage identifier');
      }
    }
    const sanitizedFilename = basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    await mkdir(this.baseDir, { recursive: true });
    const canonicalBase = await realpath(this.baseDir);
    let targetDir = this.baseDir;
    for (const id of [workflowRunId, jobId]) {
      targetDir = join(targetDir, id);
      await mkdir(targetDir, { recursive: true });
      this.assertWithinBase(await realpath(targetDir), canonicalBase);
    }

    const uniquePrefix = randomUUID();
    const storagePath = join(targetDir, `${uniquePrefix}_${sanitizedFilename}`);

    const hash = createHash('sha256');
    let sizeBytes = 0;

    try {
      if (Buffer.isBuffer(source)) {
        hash.update(source);
        sizeBytes = source.length;
        const writeStream = createWriteStream(storagePath);
        await new Promise<void>((resolvePromise, reject) => {
          writeStream.on('error', reject);
          writeStream.on('finish', () => resolvePromise());
          writeStream.end(source);
        });
      } else {
        const writeStream = createWriteStream(storagePath);
        source.on('data', (chunk: Buffer) => {
          hash.update(chunk);
          sizeBytes += chunk.length;
        });

        await streamPipeline(source, writeStream);
      }
    } catch (error) {
      await rm(storagePath, { force: true });
      throw error;
    }

    const checksum = hash.digest('hex');
    return {
      storagePath,
      sizeBytes,
      checksum,
    };
  }

  async getArtifactStream(storagePath: string): Promise<NodeJS.ReadableStream> {
    const resolvedPath = await this.resolveArtifactPath(storagePath);

    await stat(resolvedPath);
    return createReadStream(resolvedPath);
  }

  async deleteArtifactFile(storagePath: string): Promise<void> {
    try {
      const resolvedPath = await this.resolveArtifactPath(storagePath);
      await rm(resolvedPath, { force: true });
    } catch {
      // Best-effort removal
    }
  }
}

export const storageService = new StorageService();
