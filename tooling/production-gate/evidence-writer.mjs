import { open, rename } from "node:fs/promises";
import { dirname } from "node:path";

export async function writeEvidenceAtomically(path, evidence) {
  const temporary = `${path}.partial`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
