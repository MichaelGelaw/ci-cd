import Docker from 'dockerode';

const docker = new Docker();

interface DockerStepResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export async function pullImage(image: string): Promise<void> {
  // Check if the image already exists locally.
  try {
    await docker.getImage(image).inspect();
    return;
  } catch {
    // Image not found locally, pull it.
  }

  const stream = await docker.pull(image);

  // Wait for the pull to complete.
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      stream,
      (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      },
    );
  });
}

export async function runStepInDocker(
  image: string,
  command: string,
  workspaceDir: string,
  timeoutMs: number | undefined,
  signal?: AbortSignal,
): Promise<DockerStepResult> {
  let container: Docker.Container | undefined;

  if (signal?.aborted) {
    return {
      exit_code: null,
      stdout: '',
      stderr: '',
      error: 'Cancelled by user request',
    };
  }

  try {
    await pullImage(image);

    container = await docker.createContainer({
      Image: image,
      Cmd: ['sh', '-c', command],
      WorkingDir: '/workspace',
      HostConfig: {
        Binds: [`${workspaceDir}:/workspace`],
        Memory: 512 * 1024 * 1024,
        NanoCpus: 1_000_000_000,
        ReadonlyRootfs: false,
      },
      AttachStdout: true,
      AttachStderr: true,
    });

    await container.start();

    // Set up timeout if configured.
    let killed = false;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = async () => {
      cancelled = true;
      try {
        await container!.kill();
      } catch {
        try {
          await container!.stop({ t: 1 });
        } catch {
          // Container may have already stopped.
        }
      }
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    if (timeoutMs !== undefined) {
      timer = setTimeout(async () => {
        killed = true;
        try {
          await container!.stop({ t: 5 });
        } catch {
          // Container may have already stopped.
        }
      }, timeoutMs);
    }

    // Wait for the container to finish and get the exit code.
    const { StatusCode } = await container.wait();

    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);

    // Collect logs after the container has stopped.
    const logStream = await container.logs({
      stdout: true,
      stderr: true,
      follow: false,
    });

    // Docker multiplexes stdout/stderr in a single stream with 8-byte headers.
    // Each frame: [stream_type(1) + padding(3) + size(4)] + payload
    const { stdout, stderr } = demuxDockerLogs(logStream as unknown as Buffer);

    if (cancelled || signal?.aborted) {
      return {
        exit_code: StatusCode,
        stdout,
        stderr,
        error: 'Cancelled by user request',
      };
    }

    if (killed) {
      return {
        exit_code: StatusCode,
        stdout,
        stderr,
        error: `Step timed out after ${timeoutMs}ms`,
      };
    }

    return {
      exit_code: StatusCode,
      stdout,
      stderr,
    };
  } catch (error) {
    return {
      exit_code: null,
      stdout: '',
      stderr: '',
      error: (error as Error).message,
    };
  } finally {
    if (container) {
      try {
        await container.remove({ force: true });
      } catch {
        // Best-effort cleanup.
      }
    }
  }
}

// Docker log streams use a multiplexed format when not using TTY.
// Each frame has an 8-byte header:
//   byte 0: stream type (1 = stdout, 2 = stderr)
//   bytes 1-3: padding
//   bytes 4-7: payload size (big-endian uint32)
// Followed by the payload bytes.
function demuxDockerLogs(buffer: Buffer): { stdout: string; stderr: string } {
  let stdout = '';
  let stderr = '';
  let offset = 0;

  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) break;

    const streamType = buffer[offset]!;
    const size = buffer.readUInt32BE(offset + 4);
    offset += 8;

    if (offset + size > buffer.length) break;

    const payload = buffer.subarray(offset, offset + size).toString('utf-8');
    offset += size;

    if (streamType === 1) {
      stdout += payload;
    } else if (streamType === 2) {
      stderr += payload;
    }
  }

  return { stdout, stderr };
}
