// filename -> ArrayBuffer for every dataset loaded this session. Shared
// state between the two execution engines: the Pyodide worker writes each
// file into its virtual FS on load (runtime/python.js loadFile), and the
// lazily-initialized webR runtime replays this same map into R's FS on the
// first run_r call (runtime/r.js). One map, both engines — kept here rather
// than inside either runtime module so the two stay peers.
export const loadedFiles = new Map();
