const express = require("express");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");

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

function resolveRegistryPath(registryId) {
  const reg = serverRegistries.get(registryId);
  if (!reg) return null;
  if (reg.status !== "ready") return null;
  return reg.path;
}

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// Middleware: resolve registryId to a local filesystem path
app.use("/api", (req, res, next) => {
  if (req.path === "/server-registries") return next();
  if (!req.query.registryId) {
    return res.status(400).json({ error: "Missing registryId parameter" });
  }
  const regPath = resolveRegistryPath(req.query.registryId);
  if (!regPath) {
    return res.status(404).json({ error: "Server registry not found or not ready" });
  }
  req.registryRoot = regPath;
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
// Routes
// ---------------------------------------------------------------------------

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

app.get("/api/baseline", (req, res) => {
  res.json(getBaseline(req.registryRoot));
});

app.get("/api/depgraph/:name", (req, res) => {
  const { name } = req.params;
  const maxDepth = Math.min(parseInt(req.query.depth) || 6, 10);

  const registryPorts = listAllPortNames(req.registryRoot);
  if (registryPorts.size === 0) {
    return res.status(404).json({ error: "No ports directory found" });
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
    nodes.set(port, { id: port, inRegistry, depth, isRoot: port === name });

    if (depth >= maxDepth || !inRegistry) continue;

    const deps = getPortDependencies(req.registryRoot, port);
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
