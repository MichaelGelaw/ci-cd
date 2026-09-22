import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StorageService } from '../src/services/storage-service.js';

describe('artifact storage boundaries', () => {
  let root: string;
  let storage: StorageService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mini-ci-storage-'));
    storage = new StorageService(join(root, 'artifacts'));
    await mkdir(storage.getBaseDir());
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('rejects reads and preserves files in a sibling directory sharing the prefix', async () => {
    const outside = join(root, 'artifacts-private');
    await mkdir(outside);
    const secret = join(outside, 'secret');
    await writeFile(secret, 'private');
    await expect(storage.getArtifactStream(secret)).rejects.toThrow('Access denied');
    await storage.deleteArtifactFile(secret);
    expect(await readFile(secret, 'utf8')).toBe('private');
  });

  it('rejects symlinks escaping the storage directory', async () => {
    const secret = join(root, 'secret');
    await writeFile(secret, 'private');
    const link = join(storage.getBaseDir(), 'link');
    await symlink(secret, link);
    await expect(storage.getArtifactStream(link)).rejects.toThrow('Access denied');
    await storage.deleteArtifactFile(link);
    expect(await readFile(secret, 'utf8')).toBe('private');
  });

  it('rejects traversal identifiers before creating directories', async () => {
    await expect(storage.saveArtifact('../outside', 'job', 'file', Buffer.from('x')))
      .rejects.toThrow('Invalid artifact storage identifier');
  });

  it('removes partial files after a stream fails', async () => {
    const source = Readable.from((async function* () {
      yield Buffer.from('partial');
      throw new Error('Upload interrupted');
    })());
    await expect(storage.saveArtifact('run', 'job', 'file', source)).rejects.toThrow('Upload interrupted');
    expect(await readdir(join(storage.getBaseDir(), 'run', 'job'))).toEqual([]);
  });

  it('stores, reads, and deletes an artifact inside the storage directory', async () => {
    const result = await storage.saveArtifact('run', 'job', 'file', Buffer.from('contents'));
    expect(result.sizeBytes).toBe(8);
    const stream = await storage.getArtifactStream(result.storagePath);
    stream.resume();
    expect(await readFile(result.storagePath, 'utf8')).toBe('contents');
    await storage.deleteArtifactFile(result.storagePath);
    await expect(readFile(result.storagePath)).rejects.toThrow();
  });
});
