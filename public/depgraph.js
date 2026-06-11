(() => {
  const COLORS = {
    root: "#6c8cff",
    internal: "#4ec99b",
    external: "#e8a854",
    externalStroke: "#c47a2a",
    edge: "rgba(140,145,170,0.25)",
    edgeHover: "rgba(140,145,170,0.6)",
    label: "#e2e4f0",
    labelDim: "#8b8fa8",
    bg: "#0f1117",
  };

  let overlay, canvas, rootLabel, depthSlider, depthVal, hierarchyBtn, statusEl, popupMenu;
  let simulation, svg, gAll, gEdges, gNodes, gLabels;
  let graphData = null;
  let currentRoot = null;
  let hierarchyMode = false;
  let currentNodes = null;
  let currentEdges = null;
  let nodeSel, labelSel, linkSel;
  let wasDragged = false;
  let popupNode = null;
  let lastZoomK = 1;

  function init() {
    overlay = document.getElementById("depgraph-overlay");
    canvas = document.getElementById("depgraph-canvas");
    rootLabel = document.getElementById("depgraph-root-name");
    depthSlider = document.getElementById("depgraph-depth");
    depthVal = document.getElementById("depgraph-depth-val");
    hierarchyBtn = document.getElementById("depgraph-hierarchy");
    statusEl = document.getElementById("depgraph-status");

    document.getElementById("depgraph-close").addEventListener("click", close);
    document.getElementById("depgraph-recenter").addEventListener("click", recenter);
    depthSlider.addEventListener("input", () => {
      depthVal.textContent = depthSlider.value;
    });
    depthSlider.addEventListener("change", () => {
      if (currentRoot) open(currentRoot);
    });
    hierarchyBtn.addEventListener("click", toggleHierarchy);

    popupMenu = document.createElement("div");
    popupMenu.id = "dependencyNodePopupMenu";
    popupMenu.className = "dep-popup hidden";
    popupMenu.innerHTML = '<ul></ul>';
    document.body.appendChild(popupMenu);

    overlay.addEventListener("click", (e) => {
      if (!popupMenu.contains(e.target)) {
        hidePopup();
      }
    });

    document.getElementById("view-deps-btn").addEventListener("click", () => {
      const name = document.getElementById("detail-name").textContent;
      if (name) open(name);
    });
  }

  function hidePopup() {
    popupMenu.classList.add("hidden");
    popupNode = null;
  }

  function updatePopupPosition() {
    if (!popupNode || !svg) return;
    const t = d3.zoomTransform(svg.node());
    const screenX = t.applyX(popupNode.x);
    const screenY = t.applyY(popupNode.y);
    const canvasRect = canvas.getBoundingClientRect();
    popupMenu.style.left = (canvasRect.left + screenX + 16) + "px";
    popupMenu.style.top = (canvasRect.top + screenY) + "px";
  }

  function showPopup(portName, nodeData) {
    const ul = popupMenu.querySelector("ul");
    ul.innerHTML = "";

    const goItem = document.createElement("li");
    goItem.textContent = "Go to port";
    goItem.addEventListener("click", () => {
      hidePopup();
      close();
      if (window.vcviz && window.vcviz.selectPort) {
        window.vcviz.selectPort(portName);
      }
    });
    ul.appendChild(goItem);

    popupNode = nodeData;
    updatePopupPosition();
    popupMenu.classList.remove("hidden");
  }

  function toggleHierarchy() {
    if (!currentNodes || !simulation) return;
    hidePopup();
    hierarchyMode = !hierarchyMode;
    hierarchyBtn.classList.toggle("active", hierarchyMode);

    if (hierarchyMode) {
      applyHierarchyLayout();
    } else {
      releaseHierarchyLayout();
    }
  }

  function applyHierarchyLayout() {
    const height = canvas.clientHeight;

    const layers = new Map();
    currentNodes.forEach((n) => {
      const d = n.depth || 0;
      if (!layers.has(d)) layers.set(d, []);
      layers.get(d).push(n);
    });

    const sortedDepths = Array.from(layers.keys()).sort((a, b) => a - b);
    const columnSpacing = 200;
    const startX = 100;

    sortedDepths.forEach((depth, colIdx) => {
      const nodesInCol = layers.get(depth);
      nodesInCol.sort((a, b) => a.id.localeCompare(b.id));
      const count = nodesInCol.length;
      const colHeight = Math.max(count * 40, 100);
      const startY = (height / 2) - (colHeight / 2) + 20;

      nodesInCol.forEach((n, i) => {
        n.fx = startX + colIdx * columnSpacing;
        n.fy = startY + i * (colHeight / count);
      });
    });

    // Shift labels to the right of nodes in hierarchy mode
    labelSel
      .transition().duration(400)
      .attr("text-anchor", "start")
      .attr("dx", 18)
      .attr("dy", ".35em");

    simulation.alpha(0.3).restart();
    setTimeout(() => {
      simulation.stop();
      zoomToFit(currentNodes);
    }, 600);
  }

  function releaseHierarchyLayout() {
    currentNodes.forEach((n) => {
      n.fx = null;
      n.fy = null;
    });

    labelSel
      .transition().duration(400)
      .attr("text-anchor", "middle")
      .attr("dx", 0)
      .attr("dy", (d) => d.isRoot ? 28 : 22);

    simulation.alpha(0.6).restart();
    setTimeout(() => zoomToFit(currentNodes), 2500);
  }

  async function open(portName) {
    currentRoot = portName;
    overlay.classList.remove("hidden");
    showStatus("Resolving dependency tree\u2026");
    hierarchyMode = true;
    hierarchyBtn.classList.add("active");

    const depth = parseInt(depthSlider.value) || 4;
    const appState = window.vcviz && window.vcviz.getState();

    // When a historic version of the root port is selected, its direct
    // dependencies are resolved at that version (transitive ones at head)
    const activeVersion = appState && appState.activePort === portName ? appState.activeVersion : null;
    rootLabel.textContent = activeVersion ? `${portName} @ ${activeVersion.version}` : portName;

    if (window.vcviz && window.vcviz.setDepsOpen) window.vcviz.setDepsOpen(true);

    try {
      let data;

      if (appState && appState.localMode) {
        data = await window.vcviz.localBuildDepGraph(portName, depth);
      } else if (appState && appState.serverRegistryId) {
        let apiUrl = `/api/depgraph/${encodeURIComponent(portName)}?depth=${depth}&registryId=${encodeURIComponent(appState.serverRegistryId)}`;
        if (activeVersion) apiUrl += `&gitTree=${encodeURIComponent(activeVersion.gitTree)}`;
        const res = await fetch(apiUrl);
        data = await res.json();
        if (!res.ok) throw new Error(data.error || "Request failed");
      } else {
        throw new Error("No registry selected");
      }

      graphData = data;
      hideStatus();
      render(data);
      applyHierarchyLayout();
    } catch (err) {
      showStatus("Error: " + err.message);
    }
  }

  function close() {
    overlay.classList.add("hidden");
    if (window.vcviz && window.vcviz.setDepsOpen) window.vcviz.setDepsOpen(false);
    if (simulation) simulation.stop();
    canvas.innerHTML = "";
    currentRoot = null;
    currentNodes = null;
    currentEdges = null;
    hierarchyMode = false;
    hierarchyBtn.classList.remove("active");
    hidePopup();
  }

  function showStatus(msg) {
    statusEl.textContent = msg;
    statusEl.classList.remove("hidden");
  }
  function hideStatus() {
    statusEl.classList.add("hidden");
  }

  function recenter() {
    if (!svg || !gAll) return;
    if (currentNodes) {
      zoomToFit(currentNodes);
    } else {
      svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity);
    }
  }

  let zoom;

  function render(data) {
    canvas.innerHTML = "";

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    svg = d3.select(canvas)
      .append("svg")
      .attr("width", width)
      .attr("height", height);

    const defs = svg.append("defs");

    defs.append("marker")
      .attr("id", "arrowhead")
      .attr("viewBox", "0 -4 8 8")
      .attr("refX", 20)
      .attr("refY", 0)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-3L7,0L0,3")
      .attr("fill", COLORS.edge);

    defs.append("marker")
      .attr("id", "arrowhead-hover")
      .attr("viewBox", "0 -4 8 8")
      .attr("refX", 20)
      .attr("refY", 0)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-3L7,0L0,3")
      .attr("fill", COLORS.edgeHover);

    const glowFilter = defs.append("filter")
      .attr("id", "glow")
      .attr("x", "-50%").attr("y", "-50%")
      .attr("width", "200%").attr("height", "200%");
    glowFilter.append("feGaussianBlur")
      .attr("stdDeviation", "3")
      .attr("result", "blur");
    const merge = glowFilter.append("feMerge");
    merge.append("feMergeNode").attr("in", "blur");
    merge.append("feMergeNode").attr("in", "SourceGraphic");

    zoom = d3.zoom()
      .scaleExtent([0.1, 5])
      .on("zoom", (event) => {
        gAll.attr("transform", event.transform);
        if (popupNode) {
          if (event.sourceEvent && event.transform.k !== lastZoomK) {
            hidePopup();
          } else {
            updatePopupPosition();
          }
        }
        lastZoomK = event.transform.k;
      });

    svg.call(zoom);

    gAll = svg.append("g");
    gEdges = gAll.append("g").attr("class", "edges");
    gNodes = gAll.append("g").attr("class", "nodes");
    gLabels = gAll.append("g").attr("class", "labels");

    const nodeMap = new Map();
    data.nodes.forEach((n) => nodeMap.set(n.id, { ...n }));
    const nodes = Array.from(nodeMap.values());
    const edges = data.edges
      .filter((e) => nodeMap.has(e.source) && nodeMap.has(e.target))
      .map((e) => ({ source: e.source, target: e.target }));

    currentNodes = nodes;
    currentEdges = edges;

    simulation = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(edges).id((d) => d.id).distance(100))
      .force("charge", d3.forceManyBody().strength(-300))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collision", d3.forceCollide().radius(30))
      .force("x", d3.forceX(width / 2).strength(0.04))
      .force("y", d3.forceY(height / 2).strength(0.04));

    linkSel = gEdges.selectAll("line")
      .data(edges)
      .join("line")
      .attr("stroke", COLORS.edge)
      .attr("stroke-width", 1.2)
      .attr("marker-end", "url(#arrowhead)");

    const nodeRadius = (d) => d.isRoot ? 14 : (d.inRegistry ? 9 : 8);
    const nodeColor = (d) => d.isRoot ? COLORS.root : (d.inRegistry ? COLORS.internal : COLORS.external);

    nodeSel = gNodes.selectAll("g")
      .data(nodes)
      .join("g")
      .attr("cursor", "grab")
      .call(d3.drag()
        .on("start", dragStarted)
        .on("drag", dragged)
        .on("end", dragEnded));

    nodeSel.filter((d) => d.isRoot)
      .append("circle")
      .attr("r", 20)
      .attr("fill", "none")
      .attr("stroke", COLORS.root)
      .attr("stroke-width", 1.5)
      .attr("stroke-opacity", 0.3)
      .attr("filter", "url(#glow)");

    nodeSel.append("circle")
      .attr("r", nodeRadius)
      .attr("fill", nodeColor)
      .attr("stroke", (d) => d.inRegistry || d.isRoot ? "none" : COLORS.externalStroke)
      .attr("stroke-width", (d) => d.inRegistry ? 0 : 2)
      .attr("stroke-dasharray", (d) => d.inRegistry ? "" : "3,2");

    nodeSel.filter((d) => !d.inRegistry && !d.isRoot)
      .append("text")
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "central")
      .attr("fill", "#fff")
      .attr("font-size", "9px")
      .attr("font-weight", "700")
      .attr("pointer-events", "none")
      .text("?");

    labelSel = gLabels.selectAll("text")
      .data(nodes)
      .join("text")
      .attr("text-anchor", hierarchyMode ? "start" : "middle")
      .attr("dx", hierarchyMode ? 18 : 0)
      .attr("dy", hierarchyMode ? ".35em" : ((d) => d.isRoot ? 28 : 22))
      .attr("fill", (d) => d.isRoot ? COLORS.label : COLORS.labelDim)
      .attr("font-size", (d) => d.isRoot ? "13px" : "11px")
      .attr("font-weight", (d) => d.isRoot ? "600" : "400")
      .attr("font-family", "'Segoe UI', system-ui, sans-serif")
      .attr("pointer-events", "none")
      .text((d) => d.id);

    nodeSel.on("mouseenter", (event, d) => {
      const connected = new Set();
      connected.add(d.id);
      edges.forEach((e) => {
        const sid = typeof e.source === "object" ? e.source.id : e.source;
        const tid = typeof e.target === "object" ? e.target.id : e.target;
        if (sid === d.id) connected.add(tid);
        if (tid === d.id) connected.add(sid);
      });

      nodeSel.select("circle:last-of-type")
        .transition().duration(150)
        .attr("opacity", (n) => connected.has(n.id) ? 1 : 0.15);
      labelSel.transition().duration(150)
        .attr("opacity", (n) => connected.has(n.id) ? 1 : 0.1);
      linkSel.transition().duration(150)
        .attr("stroke", (e) => {
          const sid = typeof e.source === "object" ? e.source.id : e.source;
          const tid = typeof e.target === "object" ? e.target.id : e.target;
          return (sid === d.id || tid === d.id) ? COLORS.edgeHover : COLORS.edge;
        })
        .attr("stroke-opacity", (e) => {
          const sid = typeof e.source === "object" ? e.source.id : e.source;
          const tid = typeof e.target === "object" ? e.target.id : e.target;
          return (sid === d.id || tid === d.id) ? 1 : 0.08;
        })
        .attr("stroke-width", (e) => {
          const sid = typeof e.source === "object" ? e.source.id : e.source;
          const tid = typeof e.target === "object" ? e.target.id : e.target;
          return (sid === d.id || tid === d.id) ? 2 : 1.2;
        })
        .attr("marker-end", (e) => {
          const sid = typeof e.source === "object" ? e.source.id : e.source;
          const tid = typeof e.target === "object" ? e.target.id : e.target;
          return (sid === d.id || tid === d.id) ? "url(#arrowhead-hover)" : "url(#arrowhead)";
        });
    }).on("mouseleave", () => {
      nodeSel.select("circle:last-of-type")
        .transition().duration(200).attr("opacity", 1);
      labelSel.transition().duration(200).attr("opacity", 1);
      linkSel.transition().duration(200)
        .attr("stroke", COLORS.edge)
        .attr("stroke-opacity", 1)
        .attr("stroke-width", 1.2)
        .attr("marker-end", "url(#arrowhead)");
    });

    nodeSel.on("click", (event, d) => {
      if (wasDragged) { wasDragged = false; return; }
      event.stopPropagation();
      showPopup(d.id, d);
    });

    simulation.on("tick", () => {
      linkSel
        .attr("x1", (d) => d.source.x)
        .attr("y1", (d) => d.source.y)
        .attr("x2", (d) => d.target.x)
        .attr("y2", (d) => d.target.y);

      nodeSel.attr("transform", (d) => `translate(${d.x},${d.y})`);
      labelSel.attr("x", (d) => d.x).attr("y", (d) => d.y);

      if (popupNode) updatePopupPosition();
    });

    simulation.on("end", () => zoomToFit(nodes));
    setTimeout(() => zoomToFit(nodes), 2500);
  }

  function zoomToFit(nodes) {
    if (!nodes || !nodes.length || !svg || !gAll) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach((n) => {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x;
      if (n.y > maxY) maxY = n.y;
    });

    const padding = 80;
    const dx = maxX - minX + padding * 2;
    const dy = maxY - minY + padding * 2;
    const scale = Math.min(width / dx, height / dy, 1.5);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    svg.transition().duration(700).call(
      zoom.transform,
      d3.zoomIdentity
        .translate(width / 2, height / 2)
        .scale(scale)
        .translate(-cx, -cy)
    );
  }

  function dragStarted(event, d) {
    if (!event.active) simulation.alphaTarget(0.15).restart();
    d.fx = d.x;
    d.fy = d.y;
    d3.select(this).attr("cursor", "grabbing");
  }
  function dragged(event, d) {
    wasDragged = true;
    d.fx = event.x;
    d.fy = event.y;
  }
  function dragEnded(event, d) {
    if (!event.active) simulation.alphaTarget(0);
    if (!hierarchyMode) {
      d.fx = null;
      d.fy = null;
    }
    d3.select(this).attr("cursor", "grab");
  }

  window.depgraph = { open };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
