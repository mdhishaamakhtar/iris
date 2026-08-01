// Use current domain for API calls (works for both localhost and deployed domains)
const API_BASE = window.location.origin;
let currentTaskId = null;
let pollTimeoutId = null;
let abortController = null;
let taskStartTime = null;
let graph = null;

// State management
const StateManager = {
  save(data) {
    localStorage.setItem("iris_state", JSON.stringify(data));
  },

  load() {
    const stored = localStorage.getItem("iris_state");
    return stored ? JSON.parse(stored) : null;
  },

  clear() {
    localStorage.removeItem("iris_state");
  },
};

class PathFinderUI {
  constructor() {
    this.initializeGraph();
    this.setupEventListeners();
    this.restoreStateFromStorage();
  }

  initializeGraph() {
    const svg = d3.select("#graph");

    svg.selectAll("*").remove();

    // Reuse existing tooltip if present to avoid duplicates
    this.tooltip = d3.select(".tooltip");
    if (this.tooltip.empty()) {
      this.tooltip = d3.select("body").append("div").attr("class", "tooltip");
    }

    graph = {
      svg: svg,
      width: 0, // Will be set in renderGraph
      height: 500,
      nodes: [],
      links: [],
      simulation: null,
    };
  }

  setupEventListeners() {
    document.getElementById("startPage").addEventListener("keypress", (e) => {
      if (e.key === "Enter") this.findPath();
    });

    document.getElementById("endPage").addEventListener("keypress", (e) => {
      if (e.key === "Enter") this.findPath();
    });

    // Auto-save state and update button state on input changes
    document.getElementById("startPage").addEventListener("input", () => {
      this.saveCurrentState();
      this.updateButtonState();
    });
    document.getElementById("endPage").addEventListener("input", () => {
      this.saveCurrentState();
      this.updateButtonState();
    });

    // Keyboard activation for "Currently Exploring" node link
    document.getElementById("lastNode").addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        const el = document.getElementById("lastNode");
        if (!el.classList.contains("disabled")) {
          e.preventDefault();
          openWikipediaPage(el.textContent);
        }
      }
    });
  }

  restoreStateFromStorage() {
    const savedState = StateManager.load();
    if (savedState) {
      if (savedState.startPage) {
        document.getElementById("startPage").value = savedState.startPage;
      }
      if (savedState.endPage) {
        document.getElementById("endPage").value = savedState.endPage;
      }

      // If there's an active task, try to restore it
      if (savedState.taskId && savedState.status === "IN_PROGRESS") {
        currentTaskId = savedState.taskId;
        this.showVisualizationSection();
        this.showProgressLoader();
        // Ensure header matches saved pages and stats are reset until updates arrive
        this.resetProgressUI();
        this.showLoading(); // Disable button for active task
        this.pollTaskStatus();
      } else if (savedState.result && savedState.result.path) {
        // Restore completed result
        this.showVisualizationSection();
        this.handlePathFound(savedState.result);
      }
    }

    // Update button state after restoration
    this.updateButtonState();
  }

  saveCurrentState() {
    const state = {
      startPage: document.getElementById("startPage").value,
      endPage: document.getElementById("endPage").value,
      taskId: currentTaskId,
      status: currentTaskId ? "IN_PROGRESS" : "IDLE",
      timestamp: Date.now(),
    };
    StateManager.save(state);
  }

  updateButtonState() {
    const startPage = document.getElementById("startPage").value.trim();
    const endPage = document.getElementById("endPage").value.trim();
    const savedState = StateManager.load();

    // Button should be disabled if:
    // 1. Currently loading (currentTaskId exists)
    // 2. Input fields are empty
    // 3. Current inputs match saved completed result (no change)

    let shouldDisable = false;

    // Check if currently loading
    if (currentTaskId) {
      shouldDisable = true;
    }
    // Check if inputs are empty
    else if (!startPage || !endPage) {
      shouldDisable = true;
    }
    // Check if current inputs match saved completed result
    else if (
      savedState &&
      savedState.status === "COMPLETED" &&
      savedState.result
    ) {
      const matchesSaved =
        startPage === savedState.startPage && endPage === savedState.endPage;
      if (matchesSaved) {
        shouldDisable = true;
      }
    }

    document.getElementById("findPathBtn").disabled = shouldDisable;
  }

  clearActiveTask() {
    // Cancel pending poll timeout
    if (pollTimeoutId) {
      clearTimeout(pollTimeoutId);
      pollTimeoutId = null;
    }

    // Abort any in-flight fetch requests
    if (abortController) {
      abortController.abort();
      abortController = null;
    }

    // Clear current task ID and start time
    currentTaskId = null;
    taskStartTime = null;

    // Update button state
    this.updateButtonState();
  }

  showLoading() {
    // Swap find path → cancel
    document.getElementById("findPathBtn").classList.add("hidden");
    document.getElementById("cancelBtn").classList.remove("hidden");
    document.getElementById("error").classList.add("hidden");
  }

  hideLoading() {
    // Swap cancel → find path
    document.getElementById("cancelBtn").classList.add("hidden");
    document.getElementById("findPathBtn").classList.remove("hidden");
    // Use updateButtonState instead of directly enabling
    this.updateButtonState();
  }

  showError(message) {
    this.hideLoading();
    document.getElementById("error").classList.remove("hidden");
    document.getElementById("errorMessage").textContent = message;
  }

  showVisualizationSection() {
    const section = document.getElementById("visualizationSection");
    section.classList.add("show");
    // Show the unified progress loader immediately to avoid flicker
    this.showProgressLoader();
    // Reset UI to a clean slate for this run
    this.resetProgressUI();
  }

  showGraphLoader() {
    const container = document.getElementById("graphContainer");
    container.classList.add("loading");
    document.getElementById("graphLoader").classList.remove("hidden");
    document.getElementById("searchProgress").classList.add("hidden");
    document.getElementById("graph").classList.add("hidden");
  }

  showProgressLoader() {
    const container = document.getElementById("graphContainer");
    container.classList.add("loading");
    document.getElementById("graphLoader").classList.add("hidden");
    const sp = document.getElementById("searchProgress");
    sp.classList.remove("hidden");
    document.getElementById("graph").classList.add("hidden");
  }

  resetProgressUI() {
    // Ensure header matches current inputs
    const startPage = document.getElementById("startPage").value.trim() || "-";
    const endPage = document.getElementById("endPage").value.trim() || "-";
    document.getElementById("searchPath").textContent =
      `${startPage} → ${endPage}`;

    // Zero stats
    document.getElementById("nodesExplored").textContent = "0";
    document.getElementById("queueSize").textContent = "0";
    document.getElementById("elapsedTime").textContent = "0s";

    // Disable last node click
    const lastNodeEl = document.getElementById("lastNode");
    lastNodeEl.textContent = "-";
    lastNodeEl.classList.add("disabled");
    lastNodeEl.setAttribute("tabindex", "-1");
    lastNodeEl.setAttribute("aria-disabled", "true");

    // Reset depth. The real budget arrives with the first progress update;
    // until then keep whatever count is already rendered.
    this.updateDepthIndicator(
      0,
      document.getElementById("depthDots").children.length || 6,
    );
  }

  updateProgressDisplay(progressData) {
    if (!progressData || !progressData.search_stats) {
      return;
    }

    const stats = progressData.search_stats;

    // Update search path header
    document.getElementById("searchPath").textContent =
      `${stats.start_page} → ${stats.end_page}`;

    // Update depth indicator
    this.updateDepthIndicator(stats.current_depth || 0, stats.max_depth || 6);

    // Update statistics
    document.getElementById("nodesExplored").textContent =
      stats.nodes_explored?.toLocaleString() || "0";
    document.getElementById("queueSize").textContent =
      stats.queue_size?.toLocaleString() || "0";
    document.getElementById("elapsedTime").textContent =
      `${progressData.search_time_elapsed || 0}s`;
    const lastNodeEl = document.getElementById("lastNode");
    const ln = stats.last_node || "-";
    lastNodeEl.textContent = ln;
    const openable = Boolean(ln) && ln !== "-";
    lastNodeEl.classList.toggle("disabled", !openable);
    lastNodeEl.setAttribute("tabindex", openable ? "0" : "-1");
    lastNodeEl.setAttribute("aria-disabled", String(!openable));
  }

  updateDepthIndicator(currentDepth, maxDepth) {
    const container = document.getElementById("depthDots");
    const total = Math.max(1, Math.round(maxDepth));

    // Reconcile the dot count with the depth budget the server reported.
    while (container.children.length > total) {
      container.lastElementChild.remove();
    }
    while (container.children.length < total) {
      const dot = document.createElement("div");
      dot.className = "depth-dot";
      container.appendChild(dot);
    }

    const dots = container.querySelectorAll(".depth-dot");

    dots.forEach((dot, index) => {
      dot.classList.remove("active", "completed");

      if (index < currentDepth) {
        dot.classList.add("completed");
      } else if (index === currentDepth) {
        dot.classList.add("active");
      }
    });
  }

  showGraphVisualization() {
    const container = document.getElementById("graphContainer");
    container.classList.remove("loading");
    document.getElementById("graphLoader").classList.add("hidden");
    document.getElementById("searchProgress").classList.add("hidden");
    document.getElementById("graph").classList.remove("hidden");
  }

  hidePathDisplay() {
    // Hide the path steps container and progress display
    document.getElementById("pathStepsContainer").classList.add("hidden");
    document.getElementById("searchProgress").classList.add("hidden");

    // Clear the graph visualization
    if (graph && graph.svg) {
      graph.svg.selectAll("*").remove();
    }
    // Return container to loading state while hidden
    const container = document.getElementById("graphContainer");
    container.classList.add("loading");
  }

  async findPath() {
    const startPage = document.getElementById("startPage").value.trim();
    const endPage = document.getElementById("endPage").value.trim();

    if (!startPage || !endPage) {
      this.showError("Please enter both start and end pages");
      return;
    }

    // If there's already a running task, this new request will replace it
    if (currentTaskId) {
      // Clear the previous task state
      this.clearActiveTask();
    }

    try {
      this.showLoading();
      this.hidePathDisplay();
      this.showVisualizationSection();

      // Update search path header immediately with actual pages
      document.getElementById("searchPath").textContent =
        `${startPage} → ${endPage}`;

      // Create a new AbortController for this request chain
      abortController = new AbortController();

      const response = await fetch(`${API_BASE}/getPath`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          start: startPage,
          end: endPage,
          algorithm: "bidirectional",
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const errorData = await response.json();
          message = errorData.message || message;
        } catch {
          /* non-JSON response */
        }
        throw new Error(message);
      }

      const data = await response.json();
      currentTaskId = data.task_id;
      taskStartTime = Date.now();

      // Save task ID to state for recovery
      this.saveCurrentState();

      this.pollTaskStatus();
    } catch (error) {
      if (error.name === "AbortError") return;
      const section = document.getElementById("visualizationSection");
      section.classList.remove("show");
      this.showError(`Failed to start pathfinding: ${error.message}`);
    }
  }

  async pollTaskStatus(pollErrors = 0) {
    // Capture the task ID this poll chain belongs to.
    // After every await we check whether it still matches the global
    // currentTaskId — if not, a cancel or new search happened and
    // this chain must die silently.
    const taskId = currentTaskId;
    if (!taskId) return;

    // Match server hard limit (CELERY_TASK_TIME_LIMIT = 600s)
    const MAX_TASK_POLL_MS = 600_000;
    if (taskStartTime && Date.now() - taskStartTime > MAX_TASK_POLL_MS) {
      this.clearActiveTask();
      this.hideLoading();
      document.getElementById("visualizationSection").classList.remove("show");
      this.showError("Search timed out. Please try again.");
      StateManager.clear();
      return;
    }

    const MAX_POLL_ERRORS = 5;

    try {
      const response = await fetch(
        `${API_BASE}/tasks/status/${currentTaskId}`,
        {
          signal: abortController?.signal,
        },
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      // Check again after parsing
      if (currentTaskId !== taskId) return;

      switch (data.status) {
        case "PENDING":
          // Keep the progress loader visible while waiting for first callback
          this.showProgressLoader();
          // Show zeroed stats while we wait
          this.resetProgressUI();
          // Header already shows start→end; stats will populate on first update
          pollTimeoutId = setTimeout(() => this.pollTaskStatus(), 1000);
          break;

        case "IN_PROGRESS":
          // Switch to progress display and update with real data
          this.showProgressLoader();
          if (data.progress) {
            this.updateProgressDisplay(data.progress);
          }
          pollTimeoutId = setTimeout(() => this.pollTaskStatus(), 1000);
          break;

        case "SUCCESS":
          this.handlePathFound(data.result);
          break;

        case "FAILURE":
          this.clearActiveTask();
          this.hideLoading();
          const section = document.getElementById("visualizationSection");
          section.classList.remove("show");
          this.showError(data.error || "Task failed");
          StateManager.clear();
          break;

        case "REVOKED":
          this.clearActiveTask();
          this.hideLoading();
          document
            .getElementById("visualizationSection")
            .classList.remove("show");
          this.showError("Search was cancelled.");
          StateManager.clear();
          break;

        default:
          this.clearActiveTask();
          this.hideLoading();
          document
            .getElementById("visualizationSection")
            .classList.remove("show");
          this.showError(`Unknown task status: ${data.status}`);
          StateManager.clear();
      }
    } catch (error) {
      if (error.name === "AbortError") return;

      // Stale chain — don't clobber the new search's UI
      if (currentTaskId !== taskId) return;

      const nextErrors = pollErrors + 1;
      if (nextErrors < MAX_POLL_ERRORS) {
        // Transient failure (timeout, network blip) — retry with back-off
        pollTimeoutId = setTimeout(() => this.pollTaskStatus(nextErrors), 2000);
        return;
      }

      // Too many consecutive failures — give up
      this.clearActiveTask();
      this.hideLoading();
      const section = document.getElementById("visualizationSection");
      section.classList.remove("show");
      this.showError(`Lost connection to server. Please try again.`);
      StateManager.clear();
    }
  }

  handlePathFound(result) {
    this.hideLoading();

    if (!result.path || result.path.length === 0) {
      // Check if this is actually a nested error response
      if (result.status === "FAILURE" && result.error) {
        this.clearActiveTask();
        const section = document.getElementById("visualizationSection");
        section.classList.remove("show");
        this.showError(result.error);
        StateManager.clear();
        return;
      }

      // Fallback to generic message for actual empty paths
      this.clearActiveTask();
      const section = document.getElementById("visualizationSection");
      section.classList.remove("show");
      this.showError("No path found between the pages");
      StateManager.clear();
      return;
    }

    // Save successful result to state
    const state = StateManager.load() || {};
    state.result = result;
    state.status = "COMPLETED";
    StateManager.save(state);

    this.showGraphVisualization();
    this.visualizePath(result.path);
    this.displayPathList(result.path, result);

    // Clear task ID since it's completed and update button state
    currentTaskId = null;
    this.updateButtonState();
  }

  // Re-render graph responsively based on saved, completed result
  rerenderFromState() {
    const savedState = StateManager.load();
    if (
      savedState &&
      savedState.status === "COMPLETED" &&
      savedState.result &&
      savedState.result.path
    ) {
      this.initializeGraph();
      this.visualizePath(savedState.result.path);
      this.showGraphVisualization();
    }
  }

  visualizePath(path) {
    const nodes = path.map((page, index) => ({
      id: page,
      name: page,
      index: index,
      isStart: index === 0,
      isEnd: index === path.length - 1,
    }));

    const links = [];
    for (let i = 0; i < path.length - 1; i++) {
      links.push({
        source: path[i],
        target: path[i + 1],
        isPath: true,
      });
    }

    this.renderGraph(nodes, links);
  }

  renderGraph(nodes, links) {
    const { svg } = graph;

    svg.selectAll("*").remove();

    // Content-box width. clientWidth excludes borders, so subtracting the
    // padding lands exactly on the box the SVG is stretched to fill; using
    // getBoundingClientRect here left the viewBox 2px wider than the element
    // and scaled every node position by a fraction of a percent.
    const container = document.getElementById("graphContainer");
    const width = contentWidth(container);
    const nodeCount = nodes.length;

    // Narrow viewports read the path top-to-bottom instead of left-to-right
    const vertical = width < 520;
    const VERTICAL_SPACING = 92;
    const calculatedHeight = vertical
      ? Math.max(380, Math.min(760, 112 + (nodeCount - 1) * VERTICAL_SPACING))
      : Math.max(400, Math.min(600, nodeCount * 60));
    graph.vertical = vertical;

    // Update graph object
    graph.width = width;
    graph.height = calculatedHeight;

    // Set SVG dimensions and accessible label
    const pathDescription = nodes.map((n) => n.name).join(" → ");
    svg
      .attr("width", width)
      .style("height", calculatedHeight + "px")
      .attr("viewBox", `0 0 ${width} ${calculatedHeight}`)
      .attr("aria-label", `Path visualization: ${pathDescription}`)
      .style("display", "block");

    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    // Measure label text with the real font instead of estimating by character count
    const measureCtx = document.createElement("canvas").getContext("2d");
    measureCtx.font = "500 12px 'JetBrains Mono', monospace";

    const ELLIPSIS = "…";
    const measure = (s) => measureCtx.measureText(s).width;
    const trimToBudget = (s, budget) => {
      if (measure(s) <= budget) return s;
      let t = s;
      while (t.length > 1 && measure(t + ELLIPSIS) > budget) {
        t = t.slice(0, -1);
      }
      return t.trimEnd() + ELLIPSIS;
    };
    // Wrap a title onto at most two lines, trimming only when unavoidable
    const buildLabelLines = (name, budget) => {
      if (measure(name) <= budget) return [name];
      const words = name.split(" ");
      if (words.length === 1) return [trimToBudget(name, budget)];
      let line1 = "";
      let i = 0;
      while (i < words.length) {
        if (!line1) {
          line1 = words[i];
          i++;
        } else if (measure(line1 + " " + words[i]) <= budget) {
          line1 += " " + words[i];
          i++;
        } else {
          break;
        }
      }
      const rest = words.slice(i).join(" ");
      if (!rest) return [trimToBudget(line1, budget)];
      return [trimToBudget(line1, budget), trimToBudget(rest, budget)];
    };

    const seedPadX = 70;
    const spanLimit =
      nodeCount > 1 ? (width - seedPadX * 2) / (nodeCount - 1) : width;
    const lineBudget = vertical
      ? width - 56
      : Math.min(170, Math.max(96, spanLimit - 24));

    nodes.forEach((d) => {
      d.lines = buildLabelLines(d.name, lineBudget);
      d.labelWidth = Math.max(...d.lines.map(measure));
      d.boxWidth = d.labelWidth + 24;
      d.boxHeight = 26 + (d.lines.length - 1) * 14;
      d.collideR = vertical ? 34 : Math.max(30, d.boxWidth / 2 + 8);
    });

    // Seed positions in path order so the chain renders in reading
    // direction instead of untangling from a random cluster
    if (vertical) {
      const seedPadTop = 56;
      const seedPadBottom = 56;
      nodes.forEach((d, i) => {
        const t = nodeCount === 1 ? 0.5 : i / (nodeCount - 1);
        d.seedX = width / 2 + (i % 2 === 0 ? -1 : 1) * 12;
        d.seedY =
          seedPadTop + t * (calculatedHeight - seedPadTop - seedPadBottom);
        d.x = d.seedX;
        d.y = d.seedY;
      });
    } else {
      nodes.forEach((d, i) => {
        const t = nodeCount === 1 ? 0.5 : i / (nodeCount - 1);
        d.seedX = seedPadX + t * (width - seedPadX * 2);
        d.seedY =
          calculatedHeight / 2 +
          (i % 2 === 0 ? -1 : 1) * Math.min(32, calculatedHeight * 0.07);
        d.x = d.seedX;
        d.y = d.seedY;
      });
    }

    // Add arrow marker for directed edges — color read from CSS token at render time
    const accentBlue =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--accent-blue")
        .trim() || "#58A6FF";
    const defs = svg.append("defs");
    defs
      .append("marker")
      .attr("id", "arrowhead")
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 9)
      .attr("refY", 0)
      .attr("markerWidth", 11)
      .attr("markerHeight", 11)
      .attr("markerUnits", "userSpaceOnUse")
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-5L10,0L0,5")
      .attr("fill", accentBlue);

    // Create main group
    const g = svg.append("g");

    // Create links; the arrowhead marker is attached when each edge
    // finishes its draw-in (immediately under reduced motion)
    const linkGroup = g.append("g").attr("class", "links");
    const link = linkGroup
      .selectAll("path.link")
      .data(links)
      .enter()
      .append("path")
      .attr("class", (d) => (d.isPath ? "link path" : "link"));

    // Create nodes
    let isDragging = false;
    const node = g
      .append("g")
      .attr("class", "nodes")
      .selectAll("circle")
      .data(nodes)
      .enter()
      .append("circle")
      .attr("class", (d) => {
        let classes = "node";
        if (d.isStart) classes += " start";
        if (d.isEnd) classes += " end";
        return classes;
      })
      .attr("r", 14)
      // Ensure touch devices dedicate gestures to drag
      .style("touch-action", "none")
      .on("mouseover", (event, d) => {
        // Avoid tooltip on touch to prevent interference
        const isTouch =
          event?.pointerType === "touch" || event?.type?.startsWith("touch");
        if (isTouch) return;
        this.tooltip
          .style("opacity", 1)
          .text(`${d.name} — Step ${d.index + 1} of ${nodes.length}`)
          .style("left", event.pageX + 10 + "px")
          .style("top", event.pageY - 10 + "px");
      })
      .on("mouseout", (event) => {
        const isTouch =
          event?.pointerType === "touch" || event?.type?.startsWith("touch");
        if (isTouch) return;
        this.tooltip.style("opacity", 0);
      })
      .on("click", (event, d) => {
        if (isDragging) return;
        window.open(
          `https://en.wikipedia.org/wiki/${encodeURIComponent(d.name)}`,
          "_blank",
        );
      })
      .on("dblclick", (event, d) => {
        // Double-click to release node from fixed position
        d.fx = null;
        d.fy = null;
        simulation.alphaTarget(0.08).restart();
        setTimeout(() => simulation.alphaTarget(0), 150);
      })
      .call(
        d3
          .drag()
          .on("start", (event, d) => {
            // Prevent native scrolling/gestures only for touch
            const se = event.sourceEvent;
            const isTouch =
              se && (se.pointerType === "touch" || se.type === "touchstart");
            if (isTouch) {
              se.preventDefault();
              se.stopPropagation();
            }
            isDragging = true;
            if (!event.active) simulation.alphaTarget(0.05).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on("drag", (event, d) => {
            const padding = 30;
            // Prevent default touch behaviors during drag
            const se = event.sourceEvent;
            const isTouch =
              se && (se.pointerType === "touch" || se.type === "touchmove");
            if (isTouch) {
              se.preventDefault();
            }
            // Constrain drag within bounds
            d.fx = Math.max(padding, Math.min(graph.width - padding, event.x));
            d.fy = Math.max(padding, Math.min(graph.height - padding, event.y));
          })
          .on("end", (event, d) => {
            if (!event.active) simulation.alphaTarget(0);
            // Release node to let physics take over for tight binding
            d.fx = null;
            d.fy = null;
            // Gentle restart to pull nodes back together without jolts
            simulation.alphaTarget(0.02).restart();
            setTimeout(() => {
              simulation.alphaTarget(0);
              isDragging = false;
            }, 200);
          }),
      );

    // Create label backgrounds (opaque boxes)
    const labelBg = g
      .append("g")
      .attr("class", "label-backgrounds")
      .selectAll("rect")
      .data(nodes)
      .enter()
      .append("rect")
      .attr("class", "node-label-bg")
      .attr("rx", 4)
      .attr("ry", 4);

    // Create labels (up to two lines, full title preserved when it fits)
    const label = g
      .append("g")
      .attr("class", "labels")
      .selectAll("text")
      .data(nodes)
      .enter()
      .append("text")
      .attr("class", "node-label");

    label.each(function (d) {
      const text = d3.select(this);
      d.lines.forEach((line, li) => {
        text
          .append("tspan")
          .attr("x", 0)
          .attr("dy", li === 0 ? 0 : 14)
          .text(line);
      });
    });

    labelBg
      .attr("width", (d) => d.boxWidth)
      .attr("height", (d) => d.boxHeight);

    // Link distance: span the available axis evenly
    const maxBoxWidth = Math.max(...nodes.map((d) => d.boxWidth));
    const maxBoxHeight = Math.max(...nodes.map((d) => d.boxHeight));
    const dynamicDistance = vertical
      ? Math.max(80, maxBoxHeight + 52)
      : Math.max(100, Math.min(maxBoxWidth + 36, Math.max(100, spanLimit)));
    graph.dynamicDistance = dynamicDistance;

    // Positional forces hold the path in reading order; collision keeps
    // labels clear; the chain settles quickly instead of drifting
    const simulation = d3
      .forceSimulation(nodes)
      .force(
        "link",
        d3
          .forceLink(links)
          .id((d) => d.id)
          .distance(() => graph.dynamicDistance)
          .strength(1),
      )
      .force(
        "charge",
        d3
          .forceManyBody()
          .strength(vertical ? -160 : -240)
          .distanceMax(Math.max(220, dynamicDistance * 1.5)),
      )
      .force(
        "x",
        d3.forceX((d) => d.seedX).strength(vertical ? 0.16 : 0.22),
      )
      .force(
        "y",
        d3.forceY((d) => d.seedY).strength(vertical ? 0.22 : 0.1),
      )
      .force(
        "collision",
        d3
          .forceCollide()
          .radius((d) => d.collideR)
          .strength(0.8),
      )
      .alphaDecay(0.03)
      .velocityDecay(0.45);

    // Straight edge from circle boundary to circle boundary so the
    // arrowhead lands exactly on the target's edge
    const NODE_R = 14;
    function edgePath(d) {
      const dx = d.target.x - d.source.x;
      const dy = d.target.y - d.source.y;
      const dist = Math.hypot(dx, dy) || 1;
      const ux = dx / dist;
      const uy = dy / dist;
      const sOff = NODE_R + 3;
      const tOff = NODE_R + 4;
      return `M${d.source.x + ux * sOff},${d.source.y + uy * sOff} L${d.target.x - ux * tOff},${d.target.y - uy * tOff}`;
    }

    const updatePositions = () => {
      const padX = Math.min(
        graph.width / 2 - 4,
        Math.max(28, maxBoxWidth / 2 + 6),
      );
      const padTop = 28;
      const padBottom = 34 + maxBoxHeight + 8; // room for labels below nodes

      nodes.forEach((d) => {
        d.x = Math.max(padX, Math.min(graph.width - padX, d.x));
        d.y = Math.max(padTop, Math.min(graph.height - padBottom, d.y));
      });

      link.attr("d", edgePath);

      node.attr("cx", (d) => d.x).attr("cy", (d) => d.y);

      label.attr("transform", (d) => `translate(${d.x},${d.y + 34})`);

      labelBg
        .attr("x", (d) => d.x - d.boxWidth / 2)
        .attr("y", (d) => d.y + 18);
    };

    simulation.on("tick", updatePositions);

    // Settle the layout synchronously before first paint so the graph
    // appears in its final arrangement; physics stays live for dragging.
    // simulation.tick(n) advances state without firing tick events,
    // so positions are applied once manually afterwards.
    simulation.stop();
    simulation.tick(220);
    updatePositions();

    if (prefersReducedMotion) {
      link.attr("marker-end", "url(#arrowhead)");
    } else {
      // Reveal in path order over the settled layout: each node pops,
      // then its outgoing edge draws toward the next node
      node
        .attr("r", 0)
        .transition()
        .delay((d) => d.index * 60)
        .duration(220)
        .ease(d3.easeCubicOut)
        .attr("r", NODE_R);

      label
        .style("opacity", 0)
        .transition()
        .delay((d) => d.index * 60 + 40)
        .duration(180)
        .style("opacity", 1);
      labelBg
        .style("opacity", 0)
        .transition()
        .delay((d) => d.index * 60 + 40)
        .duration(180)
        .style("opacity", 1);

      link.each(function (d) {
        const len = this.getTotalLength();
        d3.select(this)
          .attr("stroke-dasharray", len)
          .attr("stroke-dashoffset", len)
          .transition()
          .delay(d.index * 60 + 100)
          .duration(180)
          .ease(d3.easeCubicOut)
          .attr("stroke-dashoffset", 0)
          .on("end", function () {
            d3.select(this)
              .attr("stroke-dasharray", null)
              .attr("stroke-dashoffset", null)
              .attr("marker-end", "url(#arrowhead)");
          });
      });
    }

    graph.simulation = simulation;
  }

  displayPathList(path, result) {
    const pathStepsContainer = document.getElementById("pathStepsContainer");
    const pathSteps = document.getElementById("pathSteps");

    // Update stats - simple badges design
    document.getElementById("pathLength").textContent = `${path.length} steps`;
    document.getElementById("searchTime").textContent =
      `${result.search_time?.toFixed(2) || "N/A"}s`;

    // Add nodes explored to the badges (singular/plural)
    const nodesExplored =
      result.search_stats?.nodes_explored || result.nodes_explored || 0;
    const nodeText = nodesExplored === 1 ? "node" : "nodes";
    document.getElementById("nodesExploredStat").textContent =
      `${nodesExplored.toLocaleString()} ${nodeText}`;

    pathSteps.innerHTML = "";

    path.forEach((page, index) => {
      const stepDiv = document.createElement("div");
      stepDiv.className = "path-step";
      stepDiv.setAttribute("role", "button");
      stepDiv.setAttribute("tabindex", "0");
      stepDiv.setAttribute(
        "aria-label",
        `Step ${index + 1}: Open ${page} on Wikipedia`,
      );
      const openPage = () =>
        window.open(
          `https://en.wikipedia.org/wiki/${encodeURIComponent(page)}`,
          "_blank",
        );
      stepDiv.onclick = openPage;
      stepDiv.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openPage();
        }
      });

      const stepNumber = document.createElement("div");
      stepNumber.className = "step-number";
      stepNumber.textContent = index + 1;

      const stepTitle = document.createElement("div");
      stepTitle.className = "step-title";
      stepTitle.textContent = page;

      stepDiv.appendChild(stepNumber);
      stepDiv.appendChild(stepTitle);
      pathSteps.appendChild(stepDiv);
    });

    pathStepsContainer.classList.remove("hidden");
  }

  async cancelSearch() {
    if (!currentTaskId) return;

    const taskId = currentTaskId;
    this.clearActiveTask();

    // Hide UI and show message immediately (synchronous, before any await)
    document.getElementById("visualizationSection").classList.remove("show");
    this.showError("Search cancelled.");
    StateManager.clear();

    // Fire-and-forget the backend cancel — don't let its resolution
    // clobber state if the user already started a new search.
    try {
      await fetch(`${API_BASE}/tasks/${taskId}`, { method: "DELETE" });
    } catch (e) {
      // Best-effort cancel; task may already be done
    }
  }

  clearVisualization() {
    // Clear active task if any
    this.clearActiveTask();

    // Ensure cancel button is hidden and find path button is shown
    this.hideLoading();

    // Clear stored state
    StateManager.clear();

    document.getElementById("error").classList.add("hidden");
    document.getElementById("pathStepsContainer").classList.add("hidden");

    // Hide visualization section
    const section = document.getElementById("visualizationSection");
    section.classList.remove("show");
    this.showGraphLoader();

    document.getElementById("startPage").value = "";
    document.getElementById("endPage").value = "";

    // Update button state after clearing inputs
    this.updateButtonState();

    if (graph && graph.svg) {
      graph.svg.selectAll("g").remove();
      // Reset any fixed positions
      if (graph.simulation) {
        graph.simulation.nodes().forEach((d) => {
          d.fx = null;
          d.fy = null;
        });
      }
    }
  }
}

let pathFinderUI;

function findPath() {
  if (pathFinderUI) {
    pathFinderUI.findPath();
  }
}

function cancelSearch() {
  if (pathFinderUI) {
    pathFinderUI.cancelSearch();
  }
}

function clearVisualization() {
  if (pathFinderUI) {
    pathFinderUI.clearVisualization();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  pathFinderUI = new PathFinderUI();
});

// Inner width available to the graph, excluding border and padding.
function contentWidth(el) {
  const style = getComputedStyle(el);
  return (
    el.clientWidth -
    parseFloat(style.paddingLeft) -
    parseFloat(style.paddingRight)
  );
}

// Simple debounce to avoid thrashing on mobile address bar show/hide
function debounce(fn, wait) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}

// Resize: re-layout fully when the orientation flips (phone ↔ desktop),
// otherwise just update svg size, seeds, and forces in place
PathFinderUI.prototype.resizeGraph = function () {
  if (!graph || !graph.svg || !graph.simulation) return;

  const container = document.getElementById("graphContainer");
  if (!container) return;
  const newWidth = contentWidth(container);

  const newVertical = newWidth < 520;
  if (newVertical !== graph.vertical) {
    this.rerenderFromState();
    return;
  }

  const nodes = graph.simulation.nodes();
  const nodeCount = nodes.length || 0;
  const newHeight = graph.vertical
    ? Math.max(380, Math.min(760, 112 + (nodeCount - 1) * 92))
    : Math.max(400, Math.min(600, nodeCount * 60));

  // Update graph dimensions
  graph.width = newWidth;
  graph.height = newHeight;

  // Update svg size without wiping elements
  graph.svg
    .attr("width", graph.width)
    .style("height", graph.height + "px")
    .attr("viewBox", `0 0 ${graph.width} ${graph.height}`)
    .style("display", "block");

  if (graph.vertical) {
    nodes.forEach((d, i) => {
      d.seedX = newWidth / 2 + (i % 2 === 0 ? -1 : 1) * 12;
    });
  } else {
    const seedPadX = 70;
    const maxBoxWidth = Math.max(...nodes.map((d) => d.boxWidth || 0), 0);
    const spanLimit =
      nodeCount > 1 ? (newWidth - seedPadX * 2) / (nodeCount - 1) : newWidth;
    graph.dynamicDistance = Math.max(
      100,
      Math.min(maxBoxWidth + 36, Math.max(100, spanLimit)),
    );
    nodes.forEach((d, i) => {
      const t = nodeCount === 1 ? 0.5 : i / (nodeCount - 1);
      d.seedX = seedPadX + t * (newWidth - seedPadX * 2);
    });
    const linkForce = graph.simulation.force("link");
    if (linkForce && typeof linkForce.distance === "function") {
      linkForce.distance(() => graph.dynamicDistance);
    }
  }

  graph.simulation
    .force(
      "x",
      d3.forceX((d) => d.seedX).strength(graph.vertical ? 0.16 : 0.22),
    )
    .alphaTarget(0.05)
    .restart();

  // Settle gently
  setTimeout(() => graph.simulation.alphaTarget(0), 300);
};

window.addEventListener(
  "resize",
  debounce(() => {
    if (!pathFinderUI) return;
    const sectionVisible = document
      .getElementById("visualizationSection")
      ?.classList.contains("show");
    if (sectionVisible) {
      pathFinderUI.resizeGraph();
    }
  }, 120),
);

// Helper function for opening Wikipedia pages
function openWikipediaPage(pageName) {
  if (pageName && pageName !== "-") {
    window.open(
      `https://en.wikipedia.org/wiki/${encodeURIComponent(pageName)}`,
      "_blank",
    );
  }
}
