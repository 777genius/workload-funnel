import { chmod, lstat, readdir, rm } from "node:fs/promises";

async function makeFixtureTreeWritable(path) {
  let identity;
  try {
    identity = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (identity.isSymbolicLink()) return;
  if (!identity.isDirectory()) {
    await chmod(path, 0o600);
    return;
  }
  await chmod(path, 0o700);
  await Promise.all(
    (await readdir(path)).map((entry) =>
      makeFixtureTreeWritable(`${path}/${entry}`),
    ),
  );
}

export async function removeFixtureTree(path) {
  await makeFixtureTreeWritable(path);
  await rm(path, { force: true, recursive: true });
}
