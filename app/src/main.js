import * as PIXI from 'pixi.js';
import DxfParser from 'dxf-parser';

const status = document.getElementById('status');
const fileInput = document.getElementById('file-input');
const layerPanel = document.getElementById('layer-panel');
const layerList = document.getElementById('layer-list');
const layerCountEl = document.getElementById('layer-count');
const layerSearch = document.getElementById('layer-search');
const layerPanelHeader = document.getElementById('layer-panel-header');
const fileNameEl = document.getElementById('file-name');

// Clipboard for copied entities
let clipboardEntities = [];

// Layer visibility state and graphics references
const layerVisibility = new Map();
const layerGraphics = new Map();
const customLayerColors = new Map(); // User-customized colors

// Current file identifier for localStorage
let currentFileId = null;

// Current tool state
let currentTool = 'select';
const selectedEntities = new Set();
let selectionGraphics = null;

// Rectangle selection state
let isRectSelecting = false;
let rectSelectStart = null;
let selectionRectEl = null;

// Tool switching
document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentTool = btn.dataset.tool;
    updateCursor();
  });
});

// Toggle layers panel
document.getElementById('toggle-layers').addEventListener('click', () => {
  layerPanel.classList.toggle('hidden');
});

// Copy selected entities
document.getElementById('copy-selection').addEventListener('click', () => {
  if (selectedEntities.size === 0) {
    status.textContent = 'Nothing selected to copy';
    return;
  }
  // Deep copy selected entities
  clipboardEntities = [...selectedEntities].map(entity => JSON.parse(JSON.stringify(entity)));
  status.textContent = `Copied ${clipboardEntities.length} entit${clipboardEntities.length === 1 ? 'y' : 'ies'} to clipboard`;
});

function updateCursor() {
  const canvas = document.querySelector('canvas');
  if (!canvas) return;
  canvas.classList.remove('panning');
  switch (currentTool) {
    case 'pan': canvas.style.cursor = 'grab'; break;
    case 'select': canvas.style.cursor = 'crosshair'; break;
    case 'move': canvas.style.cursor = selectedEntities.size > 0 ? 'move' : 'crosshair'; break;
    case 'copy': canvas.style.cursor = selectedEntities.size > 0 ? 'copy' : 'crosshair'; break;
  }
}

// Save view state to localStorage
function saveViewState() {
  if (!currentFileId || !currentDxf) return;

  const state = {
    zoom: virtualZoom,
    pan: virtualPan,
    colors: Object.fromEntries(customLayerColors),
    visibility: Object.fromEntries(layerVisibility)
  };
  localStorage.setItem(`dxf-view-${currentFileId}`, JSON.stringify(state));
  status.textContent = '✓ View saved!';
  setTimeout(() => {
    if (currentRenderParams) {
      const zoomPercent = Math.round(virtualZoom * 100);
      status.textContent = `✓ Rendered | Zoom: ${zoomPercent}%`;
    }
  }, 1500);
}

// Load view state from localStorage
function loadViewState(fileId) {
  const saved = localStorage.getItem(`dxf-view-${fileId}`);
  if (!saved) return null;
  try {
    return JSON.parse(saved);
  } catch {
    return null;
  }
}

// Generate file ID from content hash (simple hash)
function generateFileId(text) {
  let hash = 0;
  for (let i = 0; i < Math.min(text.length, 10000); i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(16);
}

// Wire up save button
document.getElementById('save-view').addEventListener('click', saveViewState);

// Collapsible panel toggle
layerPanelHeader.addEventListener('click', () => {
  layerPanel.classList.toggle('collapsed');
});

// Search filtering
layerSearch.addEventListener('input', (e) => {
  const query = e.target.value.toLowerCase();
  const items = layerList.querySelectorAll('.layer-item');
  items.forEach(item => {
    const name = item.querySelector('.layer-name').textContent.toLowerCase();
    const fullName = item.querySelector('.layer-name').title.toLowerCase();
    const matches = name.includes(query) || fullName.includes(query);
    item.style.display = matches ? 'flex' : 'none';
  });
});

// Create Pixi app
const app = new PIXI.Application();
const canvasContainer = document.getElementById('canvas-container');
await app.init({
  width: canvasContainer.clientWidth || 1200,
  height: canvasContainer.clientHeight || 800,
  backgroundColor: 0x1a1a1a,
  antialias: true,
  resizeTo: canvasContainer
});
canvasContainer.appendChild(app.canvas);

// Handle container resize
let currentDxf = null;
let currentRenderParams = null;
let virtualZoom = 1;
let virtualPan = { x: 0, y: 0 };
let cachedBounds = null;
let cachedBaseScale = null;

const resizeObserver = new ResizeObserver(() => {
  if (currentDxf) {
    // Force PixiJS to update its internal dimensions first
    app.resize();
    // Then re-render after a brief delay to ensure dimensions are stable
    setTimeout(() => {
      app.resize(); // Double-check dimensions
      renderDxf(currentDxf, virtualZoom);
    }, 100);
  }
});
resizeObserver.observe(canvasContainer);

// Create container for zoom/pan
const viewport = new PIXI.Container();
app.stage.addChild(viewport);

// Pan/Zoom state
let isPanning = false;
let lastPanPosition = { x: 0, y: 0 };

// Mouse wheel zoom
canvasContainer.addEventListener('wheel', (e) => {
  e.preventDefault();

  const rect = app.canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
  const newZoom = virtualZoom * zoomFactor;

  // Zoom towards mouse position
  const canvasCenterX = app.screen.width / 2;
  const canvasCenterY = app.screen.height / 2;
  const worldX = (mouseX - canvasCenterX - virtualPan.x) / virtualZoom;
  const worldY = (mouseY - canvasCenterY - virtualPan.y) / virtualZoom;

  // Update zoom
  virtualZoom = newZoom;

  // Adjust pan so the world point stays under the mouse
  virtualPan.x = mouseX - worldX * virtualZoom - canvasCenterX;
  virtualPan.y = mouseY - worldY * virtualZoom - canvasCenterY;

  // Immediate re-render with new zoom
  if (currentDxf) {
    renderDxf(currentDxf, virtualZoom);
  }
});

// Middle mouse button OR Space+left-click pan
let spacePressed = false;

// Two-point move/copy state
let moveBasePoint = null;
let copyBasePoint = null;

// Helper to switch tools
function switchToTool(toolName) {
  currentTool = toolName;
  document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector(`.tool-btn[data-tool="${toolName}"]`);
  if (btn) btn.classList.add('active');
  updateCursor();
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    spacePressed = true;
    app.canvas.style.cursor = 'grab';
  }
  // ESC to deselect all and cancel operations
  if (e.code === 'Escape') {
    selectedEntities.clear();
    // Cancel any in-progress operations
    moveBasePoint = null;
    copyBasePoint = null;
    if (currentTool === 'move' || currentTool === 'copy') {
      switchToTool('select');
    }
    if (currentDxf) {
      renderDxf(currentDxf, virtualZoom);
    }
    updateSelectionInfo();
    status.textContent = 'Selection cleared';
  }
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    spacePressed = false;
    if (!isPanning) updateCursor();
  }
});

app.canvas.addEventListener('mousedown', (e) => {
  const rect = app.canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  // Middle mouse or space+click always pans
  if (e.button === 1 || (e.button === 0 && spacePressed)) {
    e.preventDefault();
    isPanning = true;
    lastPanPosition = { x: e.clientX, y: e.clientY };
    app.canvas.classList.add('panning');
    return;
  }

  // Left click behavior depends on tool
  if (e.button === 0) {
    if (currentTool === 'pan') {
      isPanning = true;
      lastPanPosition = { x: e.clientX, y: e.clientY };
      app.canvas.classList.add('panning');
    } else if (currentTool === 'select') {
      // Start rectangle selection
      isRectSelecting = true;
      rectSelectStart = { x: mouseX, y: mouseY, clientX: e.clientX, clientY: e.clientY };

      // Create selection rectangle element
      selectionRectEl = document.createElement('div');
      selectionRectEl.className = 'selection-rect';
      selectionRectEl.style.left = e.clientX + 'px';
      selectionRectEl.style.top = e.clientY + 'px';
      selectionRectEl.style.width = '0px';
      selectionRectEl.style.height = '0px';
      document.body.appendChild(selectionRectEl);
    } else if (currentTool === 'move' && selectedEntities.size > 0) {
      // Two-point move: first click = base point, second click = destination
      if (!moveBasePoint) {
        moveBasePoint = { x: mouseX, y: mouseY };
        status.textContent = `Move: Base point set. Click destination point (ESC to cancel)`;
      } else {
        // Second click - perform the move
        const dx = mouseX - moveBasePoint.x;
        const dy = mouseY - moveBasePoint.y;
        const worldDx = dx / (cachedBaseScale * virtualZoom);
        const worldDy = -dy / (cachedBaseScale * virtualZoom);

        selectedEntities.forEach(entity => {
          transformEntity(entity, worldDx, worldDy);
        });

        moveBasePoint = null;
        renderDxf(currentDxf, virtualZoom);
        status.textContent = `Moved ${selectedEntities.size} entit${selectedEntities.size === 1 ? 'y' : 'ies'}`;
        // Return to select mode
        switchToTool('select');
      }
    } else if (currentTool === 'copy' && selectedEntities.size > 0) {
      // Two-point copy: first click = base point, subsequent clicks = place copies
      if (!copyBasePoint) {
        copyBasePoint = { x: mouseX, y: mouseY };
        status.textContent = `Copy: Base point set. Click to place copies (ESC to finish)`;
      } else {
        // Place a copy at this location
        const dx = mouseX - copyBasePoint.x;
        const dy = mouseY - copyBasePoint.y;
        const worldDx = dx / (cachedBaseScale * virtualZoom);
        const worldDy = -dy / (cachedBaseScale * virtualZoom);

        const newEntities = [];
        selectedEntities.forEach(entity => {
          const copy = JSON.parse(JSON.stringify(entity));
          transformEntity(copy, worldDx, worldDy);
          newEntities.push(copy);
        });

        // Add copies to the DXF entities
        currentDxf.entities.push(...newEntities);
        renderDxf(currentDxf, virtualZoom);
        status.textContent = `Copied ${newEntities.length} entit${newEntities.length === 1 ? 'y' : 'ies'}. Click to place more (ESC to finish)`;
      }
    } else if ((currentTool === 'move' || currentTool === 'copy') && selectedEntities.size === 0) {
      status.textContent = `No entities selected. Select entities first, then use ${currentTool}`;
    }
  }
});

// Helper to transform entity coordinates
function transformEntity(entity, worldDx, worldDy) {
  if (entity.vertices && Array.isArray(entity.vertices)) {
    for (let i = 0; i < entity.vertices.length; i++) {
      entity.vertices[i].x += worldDx;
      entity.vertices[i].y += worldDy;
    }
  }
  if (entity.center) {
    entity.center.x += worldDx;
    entity.center.y += worldDy;
  }
  if (entity.startPoint) {
    entity.startPoint.x += worldDx;
    entity.startPoint.y += worldDy;
  }
  if (entity.endPoint) {
    entity.endPoint.x += worldDx;
    entity.endPoint.y += worldDy;
  }
  if (entity.controlPoints && Array.isArray(entity.controlPoints)) {
    for (let i = 0; i < entity.controlPoints.length; i++) {
      entity.controlPoints[i].x += worldDx;
      entity.controlPoints[i].y += worldDy;
    }
  }
  if (entity.fitPoints && Array.isArray(entity.fitPoints)) {
    for (let i = 0; i < entity.fitPoints.length; i++) {
      entity.fitPoints[i].x += worldDx;
      entity.fitPoints[i].y += worldDy;
    }
  }
}

app.canvas.addEventListener('mousemove', (e) => {
  const rect = app.canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  if (isPanning) {
    const dx = e.clientX - lastPanPosition.x;
    const dy = e.clientY - lastPanPosition.y;

    virtualPan.x += dx;
    virtualPan.y += dy;

    lastPanPosition = { x: e.clientX, y: e.clientY };

    if (currentDxf) {
      renderDxf(currentDxf, virtualZoom);
    }
  } else if (isRectSelecting && rectSelectStart && selectionRectEl) {
    // Update selection rectangle
    const startX = rectSelectStart.clientX;
    const startY = rectSelectStart.clientY;
    const currentX = e.clientX;
    const currentY = e.clientY;

    const left = Math.min(startX, currentX);
    const top = Math.min(startY, currentY);
    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);

    selectionRectEl.style.left = left + 'px';
    selectionRectEl.style.top = top + 'px';
    selectionRectEl.style.width = width + 'px';
    selectionRectEl.style.height = height + 'px';

    // Determine selection mode: left-to-right = window (green), right-to-left = crossing (blue)
    const isWindowSelection = currentX > startX;
    selectionRectEl.classList.remove('window', 'crossing');
    selectionRectEl.classList.add(isWindowSelection ? 'window' : 'crossing');
  }
});

app.canvas.addEventListener('mouseup', (e) => {
  const rect = app.canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  if (e.button === 1 || e.button === 0) {
    isPanning = false;
    app.canvas.classList.remove('panning');

    // Handle rectangle selection completion
    if (isRectSelecting && rectSelectStart) {
      const dx = mouseX - rectSelectStart.x;
      const dy = mouseY - rectSelectStart.y;
      const dragDistance = Math.sqrt(dx * dx + dy * dy);

      // If drag was small, treat as click selection
      if (dragDistance < 5) {
        const entity = findEntityAtPoint(mouseX, mouseY);
        if (entity) {
          if (e.shiftKey) {
            if (selectedEntities.has(entity)) {
              selectedEntities.delete(entity);
            } else {
              selectedEntities.add(entity);
            }
          } else {
            selectedEntities.clear();
            selectedEntities.add(entity);
          }
        } else if (!e.shiftKey) {
          selectedEntities.clear();
        }
      } else {
        // Rectangle selection
        const isWindowSelection = mouseX > rectSelectStart.x;
        const selRect = {
          minX: Math.min(rectSelectStart.x, mouseX),
          maxX: Math.max(rectSelectStart.x, mouseX),
          minY: Math.min(rectSelectStart.y, mouseY),
          maxY: Math.max(rectSelectStart.y, mouseY)
        };

        if (!e.shiftKey) {
          selectedEntities.clear();
        }

        // Find entities in rectangle
        selectEntitiesInRect(selRect, isWindowSelection);
      }

      // Remove selection rectangle element
      if (selectionRectEl) {
        selectionRectEl.remove();
        selectionRectEl = null;
      }
      isRectSelecting = false;
      rectSelectStart = null;

      renderDxf(currentDxf, virtualZoom);
      updateSelectionInfo();
    }

    updateCursor();
  }
});

app.canvas.addEventListener('mouseleave', () => {
  isPanning = false;
  // Clean up rectangle selection if leaving canvas
  if (selectionRectEl) {
    selectionRectEl.remove();
    selectionRectEl = null;
  }
  isRectSelecting = false;
  rectSelectStart = null;
  app.canvas.classList.remove('panning');
  updateCursor();
});

// Find entity at screen coordinates
function findEntityAtPoint(screenX, screenY) {
  if (!currentDxf || !cachedBounds || !cachedBaseScale) return null;

  const { minX, minY, maxX, maxY } = cachedBounds;
  const scale = cachedBaseScale * virtualZoom;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const canvasCenterX = app.screen.width / 2;
  const canvasCenterY = app.screen.height / 2;

  // Convert screen to world coordinates
  const worldX = (screenX - canvasCenterX - virtualPan.x) / scale + centerX;
  const worldY = -((screenY - canvasCenterY - virtualPan.y) / scale) + centerY;

  const tolerance = 5 / scale; // 5 pixels in world space

  for (const entity of currentDxf.entities) {
    if (layerVisibility.get(entity.layer) === false) continue;

    if (entity.type === 'LINE' && entity.vertices) {
      if (distToSegment(worldX, worldY, entity.vertices[0], entity.vertices[1]) < tolerance) {
        return entity;
      }
    } else if (entity.type === 'CIRCLE' && entity.center) {
      const dist = Math.hypot(worldX - entity.center.x, worldY - entity.center.y);
      if (Math.abs(dist - entity.radius) < tolerance) {
        return entity;
      }
    } else if ((entity.type === 'LWPOLYLINE' || entity.type === 'POLYLINE') && entity.vertices) {
      for (let i = 0; i < entity.vertices.length - 1; i++) {
        if (distToSegment(worldX, worldY, entity.vertices[i], entity.vertices[i + 1]) < tolerance) {
          return entity;
        }
      }
      if (entity.shape && entity.vertices.length > 1) {
        const last = entity.vertices[entity.vertices.length - 1];
        const first = entity.vertices[0];
        if (distToSegment(worldX, worldY, last, first) < tolerance) {
          return entity;
        }
      }
    } else if (entity.type === 'INSERT' && entity.name && currentDxf.blocks) {
      // Check block entities (transformed)
      const block = currentDxf.blocks[entity.name];
      if (block && block.entities) {
        for (const blockEntity of block.entities) {
          if (blockEntity.type === 'LINE' && blockEntity.vertices) {
            const p1 = transformPoint(blockEntity.vertices[0].x, blockEntity.vertices[0].y, entity);
            const p2 = transformPoint(blockEntity.vertices[1].x, blockEntity.vertices[1].y, entity);
            if (distToSegment(worldX, worldY, p1, p2) < tolerance) {
              return entity;
            }
          } else if (blockEntity.type === 'CIRCLE' && blockEntity.center) {
            const c = transformPoint(blockEntity.center.x, blockEntity.center.y, entity);
            const r = blockEntity.radius * (entity.xScale || 1);
            const dist = Math.hypot(worldX - c.x, worldY - c.y);
            if (Math.abs(dist - r) < tolerance) {
              return entity;
            }
          } else if ((blockEntity.type === 'LWPOLYLINE' || blockEntity.type === 'POLYLINE') && blockEntity.vertices) {
            for (let i = 0; i < blockEntity.vertices.length - 1; i++) {
              const p1 = transformPoint(blockEntity.vertices[i].x, blockEntity.vertices[i].y, entity);
              const p2 = transformPoint(blockEntity.vertices[i + 1].x, blockEntity.vertices[i + 1].y, entity);
              if (distToSegment(worldX, worldY, p1, p2) < tolerance) {
                return entity;
              }
            }
          } else if (blockEntity.type === 'ARC' && blockEntity.center) {
            const c = transformPoint(blockEntity.center.x, blockEntity.center.y, entity);
            const r = blockEntity.radius * (entity.xScale || 1);
            const dist = Math.hypot(worldX - c.x, worldY - c.y);
            if (Math.abs(dist - r) < tolerance) {
              return entity;
            }
          }
        }
      }
    }
  }
  return null;
}

// Distance from point to line segment
function distToSegment(px, py, v1, v2) {
  const dx = v2.x - v1.x;
  const dy = v2.y - v1.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - v1.x, py - v1.y);

  let t = ((px - v1.x) * dx + (py - v1.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));

  const projX = v1.x + t * dx;
  const projY = v1.y + t * dy;
  return Math.hypot(px - projX, py - projY);
}

// Convert world coordinates to screen coordinates
function worldToScreen(worldX, worldY) {
  const { minX, minY, maxX, maxY } = cachedBounds;
  const scale = cachedBaseScale * virtualZoom;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const canvasCenterX = app.screen.width / 2;
  const canvasCenterY = app.screen.height / 2;

  return {
    x: (worldX - centerX) * scale + canvasCenterX + virtualPan.x,
    y: -(worldY - centerY) * scale + canvasCenterY + virtualPan.y
  };
}

// Get entity bounding box in screen coordinates
function getEntityScreenBounds(entity, dxf = currentDxf) {
  let points = [];

  if (entity.type === 'LINE' && entity.vertices) {
    points = entity.vertices.map(v => worldToScreen(v.x, v.y));
  } else if (entity.type === 'CIRCLE' && entity.center) {
    const c = worldToScreen(entity.center.x, entity.center.y);
    const r = entity.radius * cachedBaseScale * virtualZoom;
    return {
      minX: c.x - r, maxX: c.x + r,
      minY: c.y - r, maxY: c.y + r
    };
  } else if ((entity.type === 'LWPOLYLINE' || entity.type === 'POLYLINE') && entity.vertices) {
    points = entity.vertices.map(v => worldToScreen(v.x, v.y));
  } else if (entity.type === 'ARC' && entity.center) {
    const c = worldToScreen(entity.center.x, entity.center.y);
    const r = entity.radius * cachedBaseScale * virtualZoom;
    return {
      minX: c.x - r, maxX: c.x + r,
      minY: c.y - r, maxY: c.y + r
    };
  } else if (entity.type === 'INSERT' && entity.name && dxf && dxf.blocks) {
    // Get bounds from all block entities (transformed)
    const block = dxf.blocks[entity.name];
    if (block && block.entities) {
      block.entities.forEach(blockEntity => {
        if (blockEntity.type === 'LINE' && blockEntity.vertices) {
          const p1 = transformPoint(blockEntity.vertices[0].x, blockEntity.vertices[0].y, entity);
          const p2 = transformPoint(blockEntity.vertices[1].x, blockEntity.vertices[1].y, entity);
          points.push(worldToScreen(p1.x, p1.y));
          points.push(worldToScreen(p2.x, p2.y));
        } else if (blockEntity.type === 'CIRCLE' && blockEntity.center) {
          const c = transformPoint(blockEntity.center.x, blockEntity.center.y, entity);
          const r = blockEntity.radius * (entity.xScale || 1);
          points.push(worldToScreen(c.x - r, c.y - r));
          points.push(worldToScreen(c.x + r, c.y + r));
        } else if ((blockEntity.type === 'LWPOLYLINE' || blockEntity.type === 'POLYLINE') && blockEntity.vertices) {
          blockEntity.vertices.forEach(v => {
            const p = transformPoint(v.x, v.y, entity);
            points.push(worldToScreen(p.x, p.y));
          });
        } else if (blockEntity.type === 'ARC' && blockEntity.center) {
          const c = transformPoint(blockEntity.center.x, blockEntity.center.y, entity);
          const r = blockEntity.radius * (entity.xScale || 1);
          points.push(worldToScreen(c.x - r, c.y - r));
          points.push(worldToScreen(c.x + r, c.y + r));
        }
      });
    }
  }

  if (points.length === 0) return null;

  return {
    minX: Math.min(...points.map(p => p.x)),
    maxX: Math.max(...points.map(p => p.x)),
    minY: Math.min(...points.map(p => p.y)),
    maxY: Math.max(...points.map(p => p.y))
  };
}

// Check if line segment intersects rectangle
function lineIntersectsRect(p1, p2, rect) {
  if (p1.x >= rect.minX && p1.x <= rect.maxX && p1.y >= rect.minY && p1.y <= rect.maxY) return true;
  if (p2.x >= rect.minX && p2.x <= rect.maxX && p2.y >= rect.minY && p2.y <= rect.maxY) return true;

  const edges = [
    [{x: rect.minX, y: rect.minY}, {x: rect.maxX, y: rect.minY}],
    [{x: rect.maxX, y: rect.minY}, {x: rect.maxX, y: rect.maxY}],
    [{x: rect.maxX, y: rect.maxY}, {x: rect.minX, y: rect.maxY}],
    [{x: rect.minX, y: rect.maxY}, {x: rect.minX, y: rect.minY}]
  ];

  for (const [e1, e2] of edges) {
    if (segmentsIntersect(p1, p2, e1, e2)) return true;
  }
  return false;
}

// Check if two line segments intersect
function segmentsIntersect(a1, a2, b1, b2) {
  const d1 = direction(b1, b2, a1);
  const d2 = direction(b1, b2, a2);
  const d3 = direction(a1, a2, b1);
  const d4 = direction(a1, a2, b2);

  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  return false;
}

function direction(p1, p2, p3) {
  return (p3.x - p1.x) * (p2.y - p1.y) - (p2.x - p1.x) * (p3.y - p1.y);
}

// Check if circle intersects rectangle
function circleIntersectsRect(center, radius, rect) {
  // Find the closest point on the rectangle to the circle center
  const closestX = Math.max(rect.minX, Math.min(center.x, rect.maxX));
  const closestY = Math.max(rect.minY, Math.min(center.y, rect.maxY));

  // Calculate distance from circle center to closest point
  const distX = center.x - closestX;
  const distY = center.y - closestY;
  const distSquared = distX * distX + distY * distY;

  // Circle intersects if closest point is within radius
  // For a ring (circle outline), we need: distance to closest point <= radius
  // AND the rectangle doesn't fit entirely inside the circle
  return distSquared <= radius * radius;
}

// Select entities within rectangle (window or crossing selection)
function selectEntitiesInRect(screenRect, isWindowSelection) {
  if (!currentDxf || !cachedBounds || !cachedBaseScale) return;

  const rectWidth = screenRect.maxX - screenRect.minX;
  const rectHeight = screenRect.maxY - screenRect.minY;

  for (const entity of currentDxf.entities) {
    if (layerVisibility.get(entity.layer) === false) continue;

    const bounds = getEntityScreenBounds(entity);
    if (!bounds) continue;

    if (isWindowSelection) {
      if (bounds.minX >= screenRect.minX && bounds.maxX <= screenRect.maxX &&
          bounds.minY >= screenRect.minY && bounds.maxY <= screenRect.maxY) {
        selectedEntities.add(entity);
      }
    } else {
      // Quick bounding box rejection
      if (bounds.maxX < screenRect.minX || bounds.minX > screenRect.maxX ||
          bounds.maxY < screenRect.minY || bounds.minY > screenRect.maxY) {
        continue;
      }

      let touches = false;

      if (entity.type === 'LINE' && entity.vertices) {
        const p1 = worldToScreen(entity.vertices[0].x, entity.vertices[0].y);
        const p2 = worldToScreen(entity.vertices[1].x, entity.vertices[1].y);
        touches = lineIntersectsRect(p1, p2, screenRect);
      } else if (entity.type === 'CIRCLE' && entity.center) {
        const c = worldToScreen(entity.center.x, entity.center.y);
        const r = entity.radius * cachedBaseScale * virtualZoom;
        touches = circleIntersectsRect(c, r, screenRect);
      } else if ((entity.type === 'LWPOLYLINE' || entity.type === 'POLYLINE') && entity.vertices) {
        for (let i = 0; i < entity.vertices.length - 1; i++) {
          const p1 = worldToScreen(entity.vertices[i].x, entity.vertices[i].y);
          const p2 = worldToScreen(entity.vertices[i + 1].x, entity.vertices[i + 1].y);
          if (lineIntersectsRect(p1, p2, screenRect)) {
            touches = true;
            break;
          }
        }
        if (!touches && entity.shape && entity.vertices.length > 1) {
          const p1 = worldToScreen(entity.vertices[entity.vertices.length - 1].x, entity.vertices[entity.vertices.length - 1].y);
          const p2 = worldToScreen(entity.vertices[0].x, entity.vertices[0].y);
          touches = lineIntersectsRect(p1, p2, screenRect);
        }
      } else if (entity.type === 'ARC' && entity.center) {
        // Approximate arc as circle for crossing selection
        const c = worldToScreen(entity.center.x, entity.center.y);
        const r = entity.radius * cachedBaseScale * virtualZoom;
        touches = circleIntersectsRect(c, r, screenRect);
      } else if (entity.type === 'INSERT' && entity.name && currentDxf.blocks) {
        // Check block entities (transformed) for crossing selection
        const block = currentDxf.blocks[entity.name];
        if (block && block.entities) {
          for (const blockEntity of block.entities) {
            if (blockEntity.type === 'LINE' && blockEntity.vertices) {
              const p1 = transformPoint(blockEntity.vertices[0].x, blockEntity.vertices[0].y, entity);
              const p2 = transformPoint(blockEntity.vertices[1].x, blockEntity.vertices[1].y, entity);
              const sp1 = worldToScreen(p1.x, p1.y);
              const sp2 = worldToScreen(p2.x, p2.y);
              if (lineIntersectsRect(sp1, sp2, screenRect)) {
                touches = true;
                break;
              }
            } else if (blockEntity.type === 'CIRCLE' && blockEntity.center) {
              const c = transformPoint(blockEntity.center.x, blockEntity.center.y, entity);
              const r = blockEntity.radius * (entity.xScale || 1);
              const sc = worldToScreen(c.x, c.y);
              const sr = r * cachedBaseScale * virtualZoom;
              if (circleIntersectsRect(sc, sr, screenRect)) {
                touches = true;
                break;
              }
            } else if ((blockEntity.type === 'LWPOLYLINE' || blockEntity.type === 'POLYLINE') && blockEntity.vertices) {
              for (let i = 0; i < blockEntity.vertices.length - 1; i++) {
                const p1 = transformPoint(blockEntity.vertices[i].x, blockEntity.vertices[i].y, entity);
                const p2 = transformPoint(blockEntity.vertices[i + 1].x, blockEntity.vertices[i + 1].y, entity);
                const sp1 = worldToScreen(p1.x, p1.y);
                const sp2 = worldToScreen(p2.x, p2.y);
                if (lineIntersectsRect(sp1, sp2, screenRect)) {
                  touches = true;
                  break;
                }
              }
              if (touches) break;
            } else if (blockEntity.type === 'ARC' && blockEntity.center) {
              const c = transformPoint(blockEntity.center.x, blockEntity.center.y, entity);
              const r = blockEntity.radius * (entity.xScale || 1);
              const sc = worldToScreen(c.x, c.y);
              const sr = r * cachedBaseScale * virtualZoom;
              if (circleIntersectsRect(sc, sr, screenRect)) {
                touches = true;
                break;
              }
            }
          }
        }
      }

      if (touches) {
        selectedEntities.add(entity);
      }
    }
  }
}

// Update status with selection info
function updateSelectionInfo() {
  if (selectedEntities.size > 0) {
    status.textContent = `Selected: ${selectedEntities.size} entit${selectedEntities.size === 1 ? 'y' : 'ies'} (Shift+click to add, Move tool to drag)`;
  }
}

app.canvas.addEventListener('contextmenu', (e) => {
  if (e.button === 1) {
    e.preventDefault();
  }
});

// Add FPS counter
let lastTime = performance.now();
let frames = 0;
let fps = 60;

app.ticker.add(() => {
  frames++;
  const currentTime = performance.now();
  if (currentTime >= lastTime + 1000) {
    fps = Math.round((frames * 1000) / (currentTime - lastTime));
    frames = 0;
    lastTime = currentTime;
  }
});

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  fileNameEl.textContent = file.name + ' (local file)';
  status.textContent = 'Loading...';
  const startTime = performance.now();
  const text = await file.text();

  try {
    const parser = new DxfParser();
    const dxf = parser.parseSync(text);
    const loadTime = (performance.now() - startTime).toFixed(0);

    currentDxf = dxf;
    window.currentDxf = dxf;

    cachedBounds = null;
    cachedBaseScale = null;

    currentFileId = generateFileId(text);
    const savedState = loadViewState(currentFileId);

    if (savedState) {
      virtualZoom = savedState.zoom || 1;
      virtualPan = savedState.pan || { x: 0, y: 0 };
      customLayerColors.clear();
      if (savedState.colors) {
        Object.entries(savedState.colors).forEach(([k, v]) => customLayerColors.set(k, v));
      }
    } else {
      virtualZoom = 1;
      virtualPan = { x: 0, y: 0 };
      customLayerColors.clear();
    }

    status.textContent = `✓ Loaded ${dxf.entities.length} entities in ${loadTime}ms | FPS: ${fps}`;
    status.className = 'success';
    buildLayerPanel(dxf, savedState?.visibility);
    renderDxf(dxf, virtualZoom);
  } catch (err) {
    status.textContent = '✗ Error: ' + err.message;
    status.className = 'error';
    console.error(err);
  }
});

// Auto-load sample DXF on startup
async function loadSampleDxf() {
  try {
    status.textContent = 'Loading...';
    fileNameEl.textContent = window.location.origin + window.location.pathname.replace('index.html', '') + 'sample.dxf';
    const response = await fetch('sample.dxf');
    if (!response.ok) throw new Error('Sample file not found');
    const text = await response.text();

    const parser = new DxfParser();
    const dxf = parser.parseSync(text);

    currentDxf = dxf;
    window.currentDxf = dxf;

    cachedBounds = null;
    cachedBaseScale = null;

    currentFileId = generateFileId(text);
    const savedState = loadViewState(currentFileId);

    if (savedState) {
      virtualZoom = savedState.zoom || 1;
      virtualPan = savedState.pan || { x: 0, y: 0 };
      customLayerColors.clear();
      if (savedState.colors) {
        Object.entries(savedState.colors).forEach(([k, v]) => customLayerColors.set(k, v));
      }
    } else {
      virtualZoom = 1;
      virtualPan = { x: 0, y: 0 };
      customLayerColors.clear();
    }

    status.textContent = `✓ Loaded sample: ${dxf.entities.length} entities`;
    status.className = 'success';
    buildLayerPanel(dxf, savedState?.visibility);
    renderDxf(dxf, virtualZoom);
  } catch (err) {
    status.textContent = 'Select a DXF file to view';
    console.log('No sample file, waiting for user upload');
  }
}
loadSampleDxf();

// AutoCAD Color Index (ACI) to hex RGB
const ACI_COLORS = {
  1: 0xFF0000, 2: 0xFFFF00, 3: 0x00FF00, 4: 0x00FFFF, 5: 0x0000FF,
  6: 0xFF00FF, 7: 0xFFFFFF, 8: 0x808080, 9: 0xC0C0C0,
  10: 0xFF0000, 11: 0xFF7F7F, 12: 0xCC0000, 13: 0xCC6666, 14: 0x990000,
  20: 0xFF3F00, 21: 0xFF9F7F, 22: 0xCC3300, 23: 0xCC7F66, 24: 0x992600,
  30: 0xFF7F00, 31: 0xFFBF7F, 32: 0xCC6600, 33: 0xCC9966, 34: 0x994C00,
  40: 0xFFBF00, 41: 0xFFDF7F, 42: 0xCC9900, 43: 0xCCB266, 44: 0x997300,
  50: 0xFFFF00, 51: 0xFFFF7F, 52: 0xCCCC00, 53: 0xCCCC66, 54: 0x999900,
  60: 0xBFFF00, 61: 0xDFFF7F, 62: 0x99CC00, 63: 0xB2CC66, 64: 0x739900,
  70: 0x7FFF00, 71: 0xBFFF7F, 72: 0x66CC00, 73: 0x99CC66, 74: 0x4C9900,
  80: 0x3FFF00, 81: 0x9FFF7F, 82: 0x33CC00, 83: 0x7FCC66, 84: 0x269900,
  90: 0x00FF00, 91: 0x7FFF7F, 92: 0x00CC00, 93: 0x66CC66, 94: 0x009900,
  100: 0x00FF3F, 101: 0x7FFF9F, 102: 0x00CC33, 103: 0x66CC7F, 104: 0x009926,
  110: 0x00FF7F, 111: 0x7FFFBF, 112: 0x00CC66, 113: 0x66CC99, 114: 0x00994C,
  120: 0x00FFBF, 121: 0x7FFFDF, 122: 0x00CC99, 123: 0x66CCB2, 124: 0x009973,
  130: 0x00FFFF, 131: 0x7FFFFF, 132: 0x00CCCC, 133: 0x66CCCC, 134: 0x009999,
  140: 0x00BFFF, 141: 0x7FDFFF, 142: 0x0099CC, 143: 0x66B2CC, 144: 0x007399,
  150: 0x007FFF, 151: 0x7FBFFF, 152: 0x0066CC, 153: 0x6699CC, 154: 0x004C99,
  160: 0x003FFF, 161: 0x7F9FFF, 162: 0x0033CC, 163: 0x667FCC, 164: 0x002699,
  170: 0x0000FF, 171: 0x7F7FFF, 172: 0x0000CC, 173: 0x6666CC, 174: 0x000099,
  180: 0x3F00FF, 181: 0x9F7FFF, 182: 0x3300CC, 183: 0x7F66CC, 184: 0x260099,
  190: 0x7F00FF, 191: 0xBF7FFF, 192: 0x6600CC, 193: 0x9966CC, 194: 0x4C0099,
  200: 0xBF00FF, 201: 0xDF7FFF, 202: 0x9900CC, 203: 0xB266CC, 204: 0x730099,
  210: 0xFF00FF, 211: 0xFF7FFF, 212: 0xCC00CC, 213: 0xCC66CC, 214: 0x990099,
  220: 0xFF00BF, 221: 0xFF7FDF, 222: 0xCC0099, 223: 0xCC66B2, 224: 0x990073,
  230: 0xFF007F, 231: 0xFF7FBF, 232: 0xCC0066, 233: 0xCC6699, 234: 0x99004C,
  240: 0xFF003F, 241: 0xFF7F9F, 242: 0xCC0033, 243: 0xCC667F, 244: 0x990026,
  250: 0x545454, 251: 0x767676, 252: 0x989898, 253: 0xBABABA, 254: 0xDCDCDC, 255: 0xFFFFFF
};

// Convert number to hex color string
function colorToHex(color) {
  return '#' + color.toString(16).padStart(6, '0');
}

// Transform a point by INSERT parameters (position, scale, rotation)
function transformPoint(x, y, insert) {
  const xScale = insert.xScale || 1;
  const yScale = insert.yScale || 1;
  const rotation = (insert.rotation || 0) * Math.PI / 180;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  // Scale, then rotate, then translate
  const sx = x * xScale;
  const sy = y * yScale;
  const rx = sx * cos - sy * sin;
  const ry = sx * sin + sy * cos;

  return {
    x: rx + insert.position.x,
    y: ry + insert.position.y
  };
}

// Draw a block's entities with INSERT transformation
function drawBlockEntity(g, blockEntity, insert, scale, offsetX, offsetY, lineWidth, color, dxf) {
  if (blockEntity.type === 'LINE' && blockEntity.vertices) {
    const p1 = transformPoint(blockEntity.vertices[0].x, blockEntity.vertices[0].y, insert);
    const p2 = transformPoint(blockEntity.vertices[1].x, blockEntity.vertices[1].y, insert);
    g.moveTo(p1.x * scale + offsetX, -p1.y * scale + offsetY);
    g.lineTo(p2.x * scale + offsetX, -p2.y * scale + offsetY);
    g.stroke({ width: lineWidth, color });
    return 1;
  } else if (blockEntity.type === 'CIRCLE' && blockEntity.center) {
    const c = transformPoint(blockEntity.center.x, blockEntity.center.y, insert);
    const r = blockEntity.radius * (insert.xScale || 1);
    g.circle(c.x * scale + offsetX, -c.y * scale + offsetY, r * scale);
    g.stroke({ width: lineWidth, color });
    return 1;
  } else if ((blockEntity.type === 'LWPOLYLINE' || blockEntity.type === 'POLYLINE') && blockEntity.vertices) {
    blockEntity.vertices.forEach((v, i) => {
      const p = transformPoint(v.x, v.y, insert);
      if (i === 0) {
        g.moveTo(p.x * scale + offsetX, -p.y * scale + offsetY);
      } else {
        g.lineTo(p.x * scale + offsetX, -p.y * scale + offsetY);
      }
    });
    if (blockEntity.shape && blockEntity.vertices.length > 0) {
      const first = transformPoint(blockEntity.vertices[0].x, blockEntity.vertices[0].y, insert);
      g.lineTo(first.x * scale + offsetX, -first.y * scale + offsetY);
    }
    g.stroke({ width: lineWidth, color });
    return 1;
  } else if (blockEntity.type === 'ARC' && blockEntity.center) {
    const c = transformPoint(blockEntity.center.x, blockEntity.center.y, insert);
    const r = blockEntity.radius * (insert.xScale || 1);
    const rotationOffset = (insert.rotation || 0) * Math.PI / 180;
    const startAngle = blockEntity.startAngle * Math.PI / 180 + rotationOffset;
    const endAngle = blockEntity.endAngle * Math.PI / 180 + rotationOffset;
    g.arc(c.x * scale + offsetX, -c.y * scale + offsetY, r * scale, -endAngle, -startAngle);
    g.stroke({ width: lineWidth, color });
    return 1;
  }
  return 0;
}

// Build the layer panel UI
function buildLayerPanel(dxf, savedVisibility = null) {
  while (layerList.firstChild) {
    layerList.removeChild(layerList.firstChild);
  }
  layerVisibility.clear();
  layerGraphics.clear();
  layerSearch.value = '';

  const layerTable = dxf.tables?.layer?.layers || {};

  const layerEntityCounts = new Map();
  dxf.entities.forEach(entity => {
    const layer = entity.layer || '0';
    layerEntityCounts.set(layer, (layerEntityCounts.get(layer) || 0) + 1);
  });

  const usedLayers = [...layerEntityCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({
      name,
      count,
      color: layerTable[name]?.color || 0x00FFFF
    }));

  layerCountEl.textContent = `(${usedLayers.length})`;

  usedLayers.forEach(layer => {
    const isVisible = savedVisibility ? (savedVisibility[layer.name] !== false) : true;
    layerVisibility.set(layer.name, isVisible);

    const item = document.createElement('label');
    item.className = 'layer-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = isVisible;
    checkbox.addEventListener('change', () => {
      layerVisibility.set(layer.name, checkbox.checked);
      const graphics = layerGraphics.get(layer.name);
      if (graphics) {
        graphics.visible = checkbox.checked;
      }
    });

    const displayColor = customLayerColors.has(layer.name)
      ? customLayerColors.get(layer.name)
      : layer.color;

    const colorSwatch = document.createElement('div');
    colorSwatch.className = 'layer-color';
    colorSwatch.style.backgroundColor = colorToHex(displayColor);

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = colorToHex(displayColor);
    colorInput.addEventListener('click', (e) => {
      e.stopPropagation();
    });
    colorInput.addEventListener('input', (e) => {
      const newColor = parseInt(e.target.value.slice(1), 16);
      customLayerColors.set(layer.name, newColor);
      colorSwatch.style.backgroundColor = e.target.value;
      if (currentDxf) {
        renderDxf(currentDxf, virtualZoom);
      }
    });
    colorSwatch.appendChild(colorInput);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'layer-name';
    const shortName = layer.name.includes('$')
      ? layer.name.split('$').pop()
      : layer.name;
    nameSpan.textContent = shortName;
    nameSpan.title = layer.name;

    const countSpan = document.createElement('span');
    countSpan.className = 'layer-count';
    countSpan.textContent = layer.count;

    item.appendChild(checkbox);
    item.appendChild(colorSwatch);
    item.appendChild(nameSpan);
    item.appendChild(countSpan);
    layerList.appendChild(item);
  });

  layerPanel.classList.add('visible');
  layerPanel.classList.add('hidden');

  document.getElementById('show-all').onclick = () => {
    layerList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.checked = true;
      cb.dispatchEvent(new Event('change'));
    });
  };
  document.getElementById('hide-all').onclick = () => {
    layerList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.checked = false;
      cb.dispatchEvent(new Event('change'));
    });
  };
}

function getEntityColor(entity, layerColors) {
  if (customLayerColors.has(entity.layer)) {
    return customLayerColors.get(entity.layer);
  }
  if (entity.color !== undefined && entity.color !== 256) {
    if (entity.color <= 255) {
      return ACI_COLORS[entity.color] || 0x00FFFF;
    }
    return entity.color;
  }
  const layerColor = layerColors[entity.layer];
  if (layerColor !== undefined) {
    return layerColor;
  }
  return 0x00FFFF;
}

function renderDxf(dxf, zoomLevel = 1) {
  const renderStart = performance.now();

  viewport.removeChildren();

  const layerColors = {};
  if (dxf.tables && dxf.tables.layer && dxf.tables.layer.layers) {
    for (const [name, layer] of Object.entries(dxf.tables.layer.layers)) {
      layerColors[name] = layer.color;
    }
  }

  const canvasWidth = app.screen.width;
  const canvasHeight = app.screen.height;

  if (!cachedBounds) {
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    // Helper to update bounds from a point
    const updateBounds = (x, y) => {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    };

    dxf.entities.forEach(entity => {
      if (entity.type === 'LINE' && entity.vertices) {
        updateBounds(entity.vertices[0].x, entity.vertices[0].y);
        updateBounds(entity.vertices[1].x, entity.vertices[1].y);
      } else if (entity.type === 'CIRCLE' && entity.center) {
        updateBounds(entity.center.x - entity.radius, entity.center.y - entity.radius);
        updateBounds(entity.center.x + entity.radius, entity.center.y + entity.radius);
      } else if ((entity.type === 'LWPOLYLINE' || entity.type === 'POLYLINE') && entity.vertices) {
        entity.vertices.forEach(v => updateBounds(v.x, v.y));
      } else if (entity.type === 'ARC' && entity.center) {
        updateBounds(entity.center.x - entity.radius, entity.center.y - entity.radius);
        updateBounds(entity.center.x + entity.radius, entity.center.y + entity.radius);
      } else if (entity.type === 'INSERT' && entity.name && dxf.blocks) {
        // Include block reference bounds (transformed)
        const block = dxf.blocks[entity.name];
        if (block && block.entities) {
          block.entities.forEach(blockEntity => {
            if (blockEntity.type === 'LINE' && blockEntity.vertices) {
              const p1 = transformPoint(blockEntity.vertices[0].x, blockEntity.vertices[0].y, entity);
              const p2 = transformPoint(blockEntity.vertices[1].x, blockEntity.vertices[1].y, entity);
              updateBounds(p1.x, p1.y);
              updateBounds(p2.x, p2.y);
            } else if (blockEntity.type === 'CIRCLE' && blockEntity.center) {
              const c = transformPoint(blockEntity.center.x, blockEntity.center.y, entity);
              const r = blockEntity.radius * (entity.xScale || 1);
              updateBounds(c.x - r, c.y - r);
              updateBounds(c.x + r, c.y + r);
            } else if ((blockEntity.type === 'LWPOLYLINE' || blockEntity.type === 'POLYLINE') && blockEntity.vertices) {
              blockEntity.vertices.forEach(v => {
                const p = transformPoint(v.x, v.y, entity);
                updateBounds(p.x, p.y);
              });
            } else if (blockEntity.type === 'ARC' && blockEntity.center) {
              const c = transformPoint(blockEntity.center.x, blockEntity.center.y, entity);
              const r = blockEntity.radius * (entity.xScale || 1);
              updateBounds(c.x - r, c.y - r);
              updateBounds(c.x + r, c.y + r);
            }
          });
        }
      }
    });

    cachedBounds = { minX, minY, maxX, maxY };
  }

  const drawingWidth = cachedBounds.maxX - cachedBounds.minX;
  const drawingHeight = cachedBounds.maxY - cachedBounds.minY;
  cachedBaseScale = Math.min((canvasWidth - 50) / drawingWidth, (canvasHeight - 50) / drawingHeight) * 0.9;

  const { minX, minY, maxX, maxY } = cachedBounds;

  const scale = cachedBaseScale * zoomLevel;

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const offsetX = (canvasWidth / 2) - (centerX * scale) + virtualPan.x;
  const offsetY = (canvasHeight / 2) + (centerY * scale) + virtualPan.y;

  const lineWidth = 1.5;

  const entitiesByLayer = new Map();
  let lineCount = 0, circleCount = 0, polyCount = 0;

  dxf.entities.forEach(entity => {
    const layer = entity.layer || '0';
    if (!entitiesByLayer.has(layer)) {
      entitiesByLayer.set(layer, []);
    }
    entitiesByLayer.get(layer).push(entity);
  });

  layerGraphics.clear();

  const selectionG = new PIXI.Graphics();

  for (const [layerName, entities] of entitiesByLayer) {
    const g = new PIXI.Graphics();

    layerGraphics.set(layerName, g);

    g.visible = layerVisibility.get(layerName) !== false;

    entities.forEach(entity => {
      const isSelected = selectedEntities.has(entity);
      const color = isSelected ? 0x00FF00 : getEntityColor(entity, layerColors);
      const width = isSelected ? 3 : lineWidth;

      if (entity.type === 'LINE' && entity.vertices) {
        lineCount++;
        g.moveTo(
          entity.vertices[0].x * scale + offsetX,
          -entity.vertices[0].y * scale + offsetY
        );
        g.lineTo(
          entity.vertices[1].x * scale + offsetX,
          -entity.vertices[1].y * scale + offsetY
        );
        g.stroke({ width, color });
      } else if (entity.type === 'CIRCLE' && entity.center) {
        circleCount++;
        g.circle(
          entity.center.x * scale + offsetX,
          -entity.center.y * scale + offsetY,
          entity.radius * scale
        );
        g.stroke({ width, color });
      } else if ((entity.type === 'LWPOLYLINE' || entity.type === 'POLYLINE') && entity.vertices) {
        polyCount++;
        entity.vertices.forEach((v, i) => {
          if (i === 0) {
            g.moveTo(v.x * scale + offsetX, -v.y * scale + offsetY);
          } else {
            g.lineTo(v.x * scale + offsetX, -v.y * scale + offsetY);
          }
        });
        if (entity.shape) {
          const first = entity.vertices[0];
          g.lineTo(first.x * scale + offsetX, -first.y * scale + offsetY);
        }
        g.stroke({ width, color });
      } else if (entity.type === 'ARC' && entity.center) {
        circleCount++;
        const startAngle = entity.startAngle * (Math.PI / 180);
        const endAngle = entity.endAngle * (Math.PI / 180);
        g.arc(
          entity.center.x * scale + offsetX,
          -entity.center.y * scale + offsetY,
          entity.radius * scale,
          -endAngle,
          -startAngle
        );
        g.stroke({ width, color });
      } else if (entity.type === 'INSERT' && entity.name && dxf.blocks) {
        // Render block reference
        const block = dxf.blocks[entity.name];
        if (block && block.entities) {
          block.entities.forEach(blockEntity => {
            drawBlockEntity(g, blockEntity, entity, scale, offsetX, offsetY, width, color, dxf);
          });
        }
      }
    });

    viewport.addChild(g);
  }

  const renderTime = (performance.now() - renderStart).toFixed(0);
  const zoomPercent = Math.round(zoomLevel * 100);
  status.textContent = `✓ Rendered in ${renderTime}ms | Lines: ${lineCount}, Circles: ${circleCount}, Polylines: ${polyCount} | FPS: ${fps} | Zoom: ${zoomPercent}%`;
  status.className = 'success';

  currentRenderParams = { lineCount, circleCount, polyCount, renderTime, zoomLevel };

  if (!window.statusInterval) {
    window.statusInterval = setInterval(() => {
      if (status.className === 'success' && currentRenderParams) {
        const zoomPercent = Math.round(currentRenderParams.zoomLevel * 100);
        status.textContent = `✓ Rendered in ${currentRenderParams.renderTime}ms | Lines: ${currentRenderParams.lineCount}, Circles: ${currentRenderParams.circleCount}, Polylines: ${currentRenderParams.polyCount} | FPS: ${fps} | Zoom: ${zoomPercent}%`;
      }
    }, 500);
  }
}
