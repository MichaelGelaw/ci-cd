import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
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

  async saveArtifact(
    workflowRunId: string,
    jobId: string,
    filename: string,
    source: NodeJS.ReadableStream | Buffer,
  ): Promise<StorageSaveResult> {
    const sanitizedFilename = basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const targetDir = join(this.baseDir, workflowRunId, jobId);
    await mkdir(targetDir, { recursive: true });

    const uniquePrefix = randomUUID().slice(0, 8);
    const storagePath = join(targetDir, `${uniquePrefix}_${sanitizedFilename}`);

    const hash = createHash('sha256');
    let sizeBytes = 0;

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

    const checksum = hash.digest('hex');
    return {
      storagePath,
      sizeBytes,
      checksum,
    };
  }

  async getArtifactStream(storagePath: string): Promise<NodeJS.ReadableStream> {
    const resolvedPath = resolve(storagePath);
    if (!resolvedPath.startsWith(this.baseDir)) {
      throw new Error('Access denied: path is outside storage directory');
    }

    await stat(resolvedPath);
    return createReadStream(resolvedPath);
  }

  async deleteArtifactFile(storagePath: string): Promise<void> {
    try {
      const resolvedPath = resolve(storagePath);
      if (resolvedPath.startsWith(this.baseDir)) {
        await rm(resolvedPath, { force: true });
      }
    } catch {
      // Best-effort removal
    }
  }
}

export const storageService = new StorageService();