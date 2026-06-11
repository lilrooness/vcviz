const express = require("express");
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const isogit = require("isomorphic-git");

const app = express();
const PORT = process.env.PORT || 3000;
const CLONE_DIR = path.join(__dirname, "cloned-registries");

// ---------------------------------------------------------------------------
// Pre-cloned server registries
// ---------------------------------------------------------------------------

let registriesConfig = [];
try {
  registriesConfig = require("./registries.config.js");
} catch {
  console.warn("No registries.config.js found — server registries disabled.");
}

const serverRegistries = new Map();

function registerSubmoduledRegistries() {
  if (registriesConfig.length === 0) return;

  for (const reg of registriesConfig) {
    const absPath = path.isAbsolute(reg.path) ? reg.path : path.join(__dirname, reg.path);
    const entry = { ...reg, path: absPath, status: "ready", error: null };
    serverRegistries.set(reg.id, entry);
  }
}

registerSubmoduledRegistries();

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// Middleware: resolve registryId to a local filesystem path
app.use("/api", (req, res, next) => {
  if (req.path === "/server-registries") return next();
  if (req.path === "/_debug") return next();
  if (!req.query.registryId) {
    return res.status(400).json({ error: "Missing registryId parameter" });
  }
  const reg = serverRegistries.get(req.query.registryId);
  if (!reg || reg.status !== "ready") {
    return res.status(404).json({ error: "Server registry not found or not ready" });
  }
  req.registry = reg;
  req.registryRoot = reg.path;
  next();
});

// ---------------------------------------------------------------------------
// Local filesystem helpers
// ---------------------------------------------------------------------------

function listPorts(rootDir) {
  const portsDir = path.join(rootDir, "ports");
  if (!fs.existsSync(portsDir)) return null;
  return fs.readdirSync(portsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

function getPortFiles(rootDir, portName) {
  const portDir = path.join(rootDir, "ports", portName);
  if (!fs.existsSync(portDir)) return [];
  return fs.readdirSync(portDir, { withFileTypes: true }).map((d) => ({
    name: d.name,
    path: `ports/${portName}/${d.name}`,
    type: d.isDirectory() ? "dir" : "file",
    size: d.isFile() ? fs.statSync(path.join(portDir, d.name)).size : null,
  }));
}

function readFile(rootDir, filePath) {
  const full = path.join(rootDir, filePath);
  if (!fs.existsSync(full)) return null;
  const stat = fs.statSync(full);
  if (stat.isDirectory()) return { isDir: true };
  return {
    name: path.basename(full),
    path: filePath,
    content: fs.readFileSync(full, "utf-8"),
    size: stat.size,
  };
}

function listDir(rootDir, dirPath) {
  const full = path.join(rootDir, dirPath);
  if (!fs.existsSync(full)) return null;
  const stat = fs.statSync(full);
  if (!stat.isDirectory()) return null;
  return fs.readdirSync(full, { withFileTypes: true }).map((d) => ({
    name: d.name,
    path: dirPath.replace(/\\/g, "/") + "/" + d.name,
    type: d.isDirectory() ? "dir" : "file",
    size: d.isFile() ? fs.statSync(path.join(full, d.name)).size : null,
  }));
}

function getVersions(rootDir, portName) {
  const firstChar = portName[0].toLowerCase();
  const versionPath = path.join(rootDir, "versions", `${firstChar}-`, `${portName}.json`);
  try {
    return JSON.parse(fs.readFileSync(versionPath, "utf-8"));
  } catch {
    return { versions: [] };
  }
}

function getBaseline(rootDir) {
  const blPath = path.join(rootDir, "versions", "baseline.json");
  try {
    return JSON.parse(fs.readFileSync(blPath, "utf-8"));
  } catch {
    return {};
  }
}

function getPortDependencies(rootDir, portName) {
  const vcpkgPath = path.join(rootDir, "ports", portName, "vcpkg.json");
  try {
    const manifest = JSON.parse(fs.readFileSync(vcpkgPath, "utf-8"));
    const deps = [];
    for (const d of manifest.dependencies || []) {
      if (typeof d === "string") deps.push(d);
      else if (d && d.name) deps.push(d.name);
    }
    return [...new Set(deps)];
  } catch {
    return [];
  }
}

function listAllPortNames(rootDir) {
  const portsDir = path.join(rootDir, "ports");
  if (!fs.existsSync(portsDir)) return new Set();
  return new Set(
    fs.readdirSync(portsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  );
}

// ---------------------------------------------------------------------------
// Versioned port access via git-tree objects
//
// Each entry in versions/<x>-/<port>.json carries a "git-tree" hash naming the
// tree object of the port directory at that version. Three tiers, in order:
//   1. local git CLI (local dev, Docker)
//   2. isomorphic-git reading the bundled .git/modules object store in pure
//      JS (Vercel has no git binary; vercel.json includes .git/modules/**)
//   3. GitHub trees/blobs API, derived from the registry url (last resort;
//      set GITHUB_TOKEN to raise the rate limit from 60 to 5000 req/h)
// Tree objects are immutable, so results are cached indefinitely.
// ---------------------------------------------------------------------------

const GIT_SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const treeCache = new Map();
const TREE_CACHE_MAX = 2000;

function cacheSet(key, value) {
  if (treeCache.size >= TREE_CACHE_MAX) {
    treeCache.delete(treeCache.keys().next().value);
  }
  treeCache.set(key, value);
  return value;
}

function isSafeTreePath(p) {
  return !p.split("/").some((seg) => seg === "" || seg === "." || seg === "..") && !p.includes("\\");
}

function githubRepoFromUrl(url) {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url || "");
  return m ? { owner: m[1], repo: m[2] } : null;
}

async function githubApi(apiPath) {
  const headers = { "User-Agent": "vcviz", Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com${apiPath}`, { headers });
  if (!res.ok) throw new Error(`GitHub API responded ${res.status} for ${apiPath}`);
  return res.json();
}

// Locate the registry's git directory: a .git dir, a .git pointer file
// (submodule worktree), or the superproject's .git/modules/<path> directly
// (the pointer file may not survive bundling). Cached on the registry entry;
// null means none found.
function resolveGitDir(reg) {
  if (reg.gitDir !== undefined) return reg.gitDir;
  let gitDir = null;
  const dotGit = path.join(reg.path, ".git");
  try {
    if (fs.statSync(dotGit).isDirectory()) {
      gitDir = dotGit;
    } else {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, "utf-8"));
      if (m) gitDir = path.resolve(reg.path, m[1]);
    }
  } catch {}
  if (!gitDir || !fs.existsSync(gitDir)) {
    const rel = path.relative(__dirname, reg.path).split(path.sep).join("/");
    const candidate = path.join(__dirname, ".git", "modules", rel);
    gitDir = fs.existsSync(candidate) ? candidate : null;
  }
  reg.gitDir = gitDir;
  return gitDir;
}

async function isoListTree(reg, treeSha, subPath) {
  const gitdir = resolveGitDir(reg);
  if (!gitdir) throw new Error("no git directory found");
  const { tree } = await isogit.readTree({ fs, gitdir, oid: treeSha, filepath: subPath || undefined });
  return tree.map((e) => ({
    name: e.path,
    type: e.type === "tree" ? "dir" : "file",
    sha: e.oid,
    size: null,
  }));
}

async function isoReadFile(reg, treeSha, filePath) {
  const gitdir = resolveGitDir(reg);
  if (!gitdir) throw new Error("no git directory found");
  const { blob } = await isogit.readBlob({ fs, gitdir, oid: treeSha, filepath: filePath });
  return Buffer.from(blob).toString("utf-8");
}

function gitListTreeLocal(rootDir, treeSha, subPath) {
  const ref = subPath ? `${treeSha}:${subPath}` : treeSha;
  const out = execFileSync("git", ["-C", rootDir, "ls-tree", "-l", "-z", ref], {
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const entries = [];
  for (const line of out.split("\0")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    const [, type, sha, size] = line.slice(0, tab).trim().split(/\s+/);
    entries.push({
      name: line.slice(tab + 1),
      type: type === "tree" ? "dir" : "file",
      sha,
      size: size === "-" ? null : parseInt(size, 10),
    });
  }
  return entries;
}

async function githubListTree(gh, treeSha, subPath) {
  let sha = treeSha;
  for (const seg of subPath ? subPath.split("/") : []) {
    const tree = await githubApi(`/repos/${gh.owner}/${gh.repo}/git/trees/${sha}`);
    const entry = (tree.tree || []).find((e) => e.path === seg && e.type === "tree");
    if (!entry) throw new Error(`Directory not found in tree: ${subPath}`);
    sha = entry.sha;
  }
  const tree = await githubApi(`/repos/${gh.owner}/${gh.repo}/git/trees/${sha}`);
  return (tree.tree || []).map((e) => ({
    name: e.path,
    type: e.type === "tree" ? "dir" : "file",
    sha: e.sha,
    size: e.size != null ? e.size : null,
  }));
}

// List the contents of `subPath` ("" for the root) inside a git tree object.
async function listTreeAtVersion(reg, treeSha, subPath) {
  const key = `ls|${reg.id}|${treeSha}|${subPath}`;
  if (treeCache.has(key)) return treeCache.get(key);

  let firstError;
  try {
    return cacheSet(key, gitListTreeLocal(reg.path, treeSha, subPath));
  } catch (e) {
    firstError = e;
  }

  try {
    return cacheSet(key, await isoListTree(reg, treeSha, subPath));
  } catch {}

  const gh = githubRepoFromUrl(reg.url);
  if (!gh) {
    throw new Error(`Version data unavailable: ${firstError.message}`);
  }
  return cacheSet(key, await githubListTree(gh, treeSha, subPath));
}

async function readFileAtVersion(reg, treeSha, filePath) {
  const key = `cat|${reg.id}|${treeSha}|${filePath}`;
  if (treeCache.has(key)) return treeCache.get(key);

  let firstError;
  try {
    const content = execFileSync("git", ["-C", reg.path, "cat-file", "blob", `${treeSha}:${filePath}`], {
      encoding: "utf-8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return cacheSet(key, content);
  } catch (e) {
    firstError = e;
  }

  try {
    return cacheSet(key, await isoReadFile(reg, treeSha, filePath));
  } catch {}

  const gh = githubRepoFromUrl(reg.url);
  if (!gh) {
    throw new Error(`Version data unavailable: ${firstError.message}`);
  }
  const lastSlash = filePath.lastIndexOf("/");
  const dir = lastSlash === -1 ? "" : filePath.slice(0, lastSlash);
  const name = lastSlash === -1 ? filePath : filePath.slice(lastSlash + 1);
  const entries = await listTreeAtVersion(reg, treeSha, dir);
  const entry = entries.find((e) => e.name === name && e.type === "file");
  if (!entry) throw new Error(`File not found in tree: ${filePath}`);
  const blob = await githubApi(`/repos/${gh.owner}/${gh.repo}/git/blobs/${entry.sha}`);
  return cacheSet(key, Buffer.from(blob.content, "base64").toString("utf-8"));
}

function parseControlDeps(text) {
  const deps = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = /^(?:Build-Depends|Depends):\s*(.+)$/.exec(line);
    if (!m) continue;
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/[\s[(]/)[0];
      if (name) deps.add(name);
    }
  }
  return [...deps];
}

async function getPortDependenciesAtVersion(reg, treeSha) {
  try {
    const manifest = JSON.parse(await readFileAtVersion(reg, treeSha, "vcpkg.json"));
    const deps = [];
    for (const d of manifest.dependencies || []) {
      if (typeof d === "string") deps.push(d);
      else if (d && d.name) deps.push(d.name);
    }
    return [...new Set(deps)];
  } catch {}
  try {
    return parseControlDeps(await readFileAtVersion(reg, treeSha, "CONTROL"));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/api/_debug", (req, res) => {
  const serverRegDir = path.join(__dirname, "server-registries");
  const info = {
    __dirname,
    cwd: process.cwd(),
    rootEntries: safeReaddir(__dirname),
    serverRegExists: fs.existsSync(serverRegDir),
    serverRegEntries: safeReaddir(serverRegDir),
    registries: [],
  };
  for (const [id, reg] of serverRegistries) {
    info.registries.push({
      id,
      path: reg.path,
      exists: fs.existsSync(reg.path),
      hasPortsDir: fs.existsSync(path.join(reg.path, "ports")),
      portsSample: safeReaddir(path.join(reg.path, "ports")).slice(0, 5),
    });
  }
  res.json(info);
});

function safeReaddir(p) {
  try {
    return fs.readdirSync(p);
  } catch (e) {
    return { error: e.message };
  }
}

app.get("/api/server-registries", (req, res) => {
  const list = [];
  for (const [id, reg] of serverRegistries) {
    list.push({ id, name: reg.name, url: reg.url, status: reg.status, error: reg.error });
  }
  res.json({ registries: list });
});

app.get("/api/ports", (req, res) => {
  const ports = listPorts(req.registryRoot);
  if (!ports) return res.status(404).json({ error: "No ports directory found" });
  res.json({ ports });
});

app.get("/api/ports/:name", (req, res) => {
  const { name } = req.params;
  res.json({ name, files: getPortFiles(req.registryRoot, name) });
});

app.get("/api/dir", (req, res) => {
  const { path: dirPath } = req.query;
  if (!dirPath) return res.status(400).json({ error: "Missing path parameter" });
  const entries = listDir(req.registryRoot, dirPath);
  if (!entries) return res.status(404).json({ error: "Directory not found" });
  res.json({ path: dirPath, files: entries });
});

app.get("/api/file", (req, res) => {
  const { path: filePath } = req.query;
  if (!filePath) return res.status(400).json({ error: "Missing path parameter" });
  const data = readFile(req.registryRoot, filePath);
  if (!data) return res.status(404).json({ error: "File not found" });
  if (data.isDir) return res.status(400).json({ error: "Path is a directory, not a file" });
  res.json(data);
});

app.get("/api/versions/:name", (req, res) => {
  res.json(getVersions(req.registryRoot, req.params.name));
});

// List files of a port at a specific version (git-tree hash). Optional ?path=
// lists a subdirectory within that tree. Paths are relative to the port root.
app.get("/api/version-files/:name", async (req, res) => {
  const { gitTree, path: subPath = "" } = req.query;
  if (!gitTree || !GIT_SHA_RE.test(gitTree)) {
    return res.status(400).json({ error: "Missing or invalid gitTree parameter" });
  }
  if (subPath && !isSafeTreePath(subPath)) {
    return res.status(400).json({ error: "Invalid path parameter" });
  }
  try {
    const entries = await listTreeAtVersion(req.registry, gitTree, subPath);
    const files = entries.map((e) => ({
      name: e.name,
      path: subPath ? `${subPath}/${e.name}` : e.name,
      type: e.type,
      size: e.size,
    }));
    res.json({ name: req.params.name, gitTree, path: subPath, files });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Read one file of a port at a specific version (git-tree hash).
app.get("/api/version-file", async (req, res) => {
  const { gitTree, path: filePath } = req.query;
  if (!gitTree || !GIT_SHA_RE.test(gitTree)) {
    return res.status(400).json({ error: "Missing or invalid gitTree parameter" });
  }
  if (!filePath || !isSafeTreePath(filePath)) {
    return res.status(400).json({ error: "Missing or invalid path parameter" });
  }
  try {
    const content = await readFileAtVersion(req.registry, gitTree, filePath);
    res.json({
      name: filePath.split("/").pop(),
      path: filePath,
      gitTree,
      content,
      size: Buffer.byteLength(content, "utf-8"),
    });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.get("/api/baseline", (req, res) => {
  res.json(getBaseline(req.registryRoot));
});

app.get("/api/depgraph/:name", async (req, res) => {
  const { name } = req.params;
  const maxDepth = Math.min(parseInt(req.query.depth) || 6, 10);

  // Optional: resolve the root port's direct dependencies at a historic
  // version. Transitive dependencies are still resolved at the registry head,
  // since git-tree objects only cover the root port's own directory.
  const gitTree = req.query.gitTree;
  if (gitTree && !GIT_SHA_RE.test(gitTree)) {
    return res.status(400).json({ error: "Invalid gitTree parameter" });
  }

  const registryPorts = listAllPortNames(req.registryRoot);
  if (registryPorts.size === 0) {
    return res.status(404).json({ error: "No ports directory found" });
  }

  let rootDeps = null;
  if (gitTree) {
    try {
      rootDeps = await getPortDependenciesAtVersion(req.registry, gitTree);
    } catch (err) {
      return res.status(404).json({ error: err.message });
    }
  }

  const nodes = new Map();
  const edges = [];
  const queue = [{ port: name, depth: 0 }];
  const visited = new Set();

  while (queue.length > 0) {
    const { port, depth } = queue.shift();
    if (visited.has(port)) continue;
    visited.add(port);

    const inRegistry = registryPorts.has(port);
    const isRoot = port === name && depth === 0;
    nodes.set(port, { id: port, inRegistry, depth, isRoot });

    if (depth >= maxDepth || (!inRegistry && !(isRoot && rootDeps))) continue;

    const deps = isRoot && rootDeps ? rootDeps : getPortDependencies(req.registryRoot, port);
    for (const dep of deps) {
      edges.push({ source: port, target: dep });
      if (!visited.has(dep)) {
        queue.push({ port: dep, depth: depth + 1 });
      }
    }
  }

  res.json({ root: name, nodes: Array.from(nodes.values()), edges });
});

app.get("/api/feature-usages/:name", (req, res) => {
  const portName = req.params.name;
  const portsDir = path.join(req.registryRoot, "ports");
  if (!fs.existsSync(portsDir)) return res.status(404).json({ error: "No ports directory found" });

  const allPorts = fs.readdirSync(portsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const usages = {};

  for (const otherPort of allPorts) {
    if (otherPort === portName) continue;
    const vcpkgPath = path.join(portsDir, otherPort, "vcpkg.json");
    try {
      const manifest = JSON.parse(fs.readFileSync(vcpkgPath, "utf-8"));
      const checkDeps = (deps) => {
        for (const dep of deps) {
          if (typeof dep !== "object" || dep.name !== portName) continue;
          for (const feat of dep.features || []) {
            if (!usages[feat]) usages[feat] = [];
            if (!usages[feat].includes(otherPort)) usages[feat].push(otherPort);
          }
        }
      };
      checkDeps(manifest.dependencies || []);
      if (manifest.features) {
        for (const fdata of Object.values(manifest.features)) {
          checkDeps(fdata.dependencies || []);
        }
      }
    } catch {}
  }

  for (const feat of Object.keys(usages)) {
    usages[feat].sort();
  }

  res.json({ port: portName, usages });
});

app.listen(PORT, () => {
  console.log(`vcviz running at http://localhost:${PORT}`);
});
