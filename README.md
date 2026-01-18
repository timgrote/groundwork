# PixiJS + dxf-parser Experiment

Docker container for evaluating PixiJS (WebGL renderer) with native DXF file support as Blueprint's foundation.

## Summary

Custom-built solution using PixiJS for WebGL-accelerated rendering and dxf-parser for native CAD file import/export. PixiJS is a game engine designed to handle 10,000+ objects at 60fps with built-in culling, batching, and LOD. This approach prioritizes performance and CAD integration over out-of-box features. Complete architectural control with zero licensing costs.

## Quick Start

**No cloning needed - uses CDN for libraries:**

```bash
# Just start the container
docker-compose up --build
```

Access at: **http://localhost:4004**

## What Just Happened?

- Docker created a container with Node.js
- Started an http-server on port 3000 (mapped to 4004)
- Serves the single HTML file
- PixiJS and dxf-parser loaded via CDN (no npm install)

## Test It

1. Open http://localhost:4004
2. Click "Choose File"
3. Select a DXF file
4. Drawing renders on canvas

**Sample DXF files:**
- Create a simple one in AutoCAD/LibreCAD
- Or find examples online

## How It Works

**Single HTML file:**
- Uses PixiJS from CDN (https://cdn.jsdelivr.net/npm/pixi.js@8)
- Uses dxf-parser from CDN
- File upload → parse DXF → render with PixiJS
- Supports: LINE, CIRCLE, POLYLINE, LWPOLYLINE entities

**Key Code:**
```javascript
// Load DXF
const parser = new DxfParser()
const dxf = parser.parseSync(fileText)

// Render with PixiJS
const graphics = new PIXI.Graphics()
dxf.entities.forEach(entity => {
  if (entity.type === 'LINE') {
    graphics.moveTo(entity.vertices[0].x, entity.vertices[0].y)
    graphics.lineTo(entity.vertices[1].x, entity.vertices[1].y)
  }
})
app.stage.addChild(graphics)
```

## Performance Test

To test with thousands of objects:

1. Create DXF with 1,000+ circles/lines
2. Load it
3. Monitor FPS (should stay 60fps)
4. Compare to tldraw with same data

## Licensing

**MIT Licensed** - Both PixiJS and dxf-parser ✅
- Free for commercial use
- No watermarks
- No licensing fees
- Full ownership

**Perfect for Groundwork** - Build, customize, sell without restrictions.

## Next Steps

- [ ] Test with real irrigation plan DXF (5,000+ heads)
- [ ] Add pan/zoom controls
- [ ] Implement spatial culling for viewport
- [ ] Add entity selection
- [ ] Integrate Yjs for collaboration
- [ ] Compare performance to tldraw

## Advantages Over tldraw

✅ **Performance:** WebGL vs Canvas 2D
✅ **DXF Support:** Native import/export
✅ **Cost:** $0 vs $6,000
✅ **Control:** Complete vs Limited
✅ **Scale:** 10,000+ objects easily

## Trade-offs

⚠️ **Development Time:** 2-3 months vs 2 weeks
⚠️ **No out-of-box tools:** Must build everything
⚠️ **No collaboration yet:** Need to add Yjs

## Files

- `index.html` - Single-file demo with inline JavaScript
- No package.json needed (uses CDN)
- No build process
- Just open and it works
