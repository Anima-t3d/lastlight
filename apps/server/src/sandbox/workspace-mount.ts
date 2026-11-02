import { isAbsolute, relative, resolve } from "path";
import type { WorkspaceMount } from "./docker.js";

/**
 * Decide how the sandbox container should mount `/home/agent/workspace`.
 *
 * The harness writes the per-task workspace to `workDir`, which is always
 * under `stateDir` (`sandboxes/<taskId>/`). In production, `stateDir` is
 * served by a named docker volume mounted into the harness container. A
 * plain `-v workDir:/home/agent/workspace` bind makes the daemon resolve
 * `workDir` against the *host* filesystem, where the named volume's
 * content is not visible — docker silently creates an empty dir at that
 * host path and mounts it, so the sandbox sees an empty workspace and the
 * skills the harness staged are never reachable.
 *
 * In volume mode we ask docker for a `volume-subpath` mount instead, so
 * the sandbox sees exactly the harness's view. In path mode (local dev,
 * or any deployment where SANDBOX_DATA_VOLUME is a host path) a normal
 * bind is correct because both views point at the same FS path.
 *
 * Edge case: if `opts.sandboxDir` was overridden to live outside `stateDir`,
 * we can't carve a volume-subpath out of the data volume — fall back to
 * a bind mount. That keeps the no-data-volume dev path working; the
 * named-volume + custom-sandboxDir combination isn't currently used.
 */
export function resolveWorkspaceMount(
  stateDir: string,
  workDir: string,
): WorkspaceMount {
  const dataVolumeRaw = process.env.SANDBOX_DATA_VOLUME || "lastlight_agent-data";
  if (isPathLike(dataVolumeRaw)) {
    return { type: "bind", hostPath: workDir };
  }
  const rel = relative(resolve(stateDir), workDir);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return { type: "bind", hostPath: workDir };
  }
  return { type: "volume-subpath", volume: dataVolumeRaw, subpath: rel };
}

export function isPathLike(value: string): boolean {
  return value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~");
}
