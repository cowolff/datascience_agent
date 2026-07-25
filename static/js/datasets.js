// File storage — plan §3.1/principle 2: uploaded files are parsed/stored
// entirely client-side, in the browser's Origin Private File System, and
// are never sent to the backend via fetch/XHR. This module only touches
// OPFS; static/js/tools.js separately pushes bytes into the Pyodide
// worker's own virtual filesystem so run_python can actually read them —
// two different filesystems for two different jobs (persistence vs.
// execution), not a duplicate write by accident.

export async function saveToOPFS(file) {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(file.name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(file);
  await writable.close();
}

export async function listOPFSFiles() {
  const root = await navigator.storage.getDirectory();
  const files = [];
  for await (const [name, handle] of root.entries()) {
    if (handle.kind === "file") {
      const f = await handle.getFile();
      files.push({ name, size: f.size });
    }
  }
  return files;
}

export async function readOPFSFile(name) {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(name);
  const file = await handle.getFile();
  return file.arrayBuffer();
}
