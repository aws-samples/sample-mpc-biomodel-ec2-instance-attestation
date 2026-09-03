import { useEffect, useRef } from 'react'
import * as $3Dmol from '3dmol'

/**
 * Renders a predicted protein structure (PDB text) with 3Dmol.js. Replaces the old
 * "Molecular viewer will be integrated here" placeholder — the backend returns the
 * PDB inline (structure.pdb_string), so we can draw it directly with no download.
 *
 * Cartoon style, spectrum-colored by residue index (a reasonable default when there
 * are no per-residue confidence values to color by).
 */
export function MoleculeViewer({ pdb }: { pdb: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<ReturnType<typeof $3Dmol.createViewer> | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el || !pdb) return

    // Create the viewer once per container.
    const viewer = $3Dmol.createViewer(el, { backgroundColor: 'white' })
    viewerRef.current = viewer

    try {
      viewer.addModel(pdb, 'pdb')
      viewer.setStyle({}, { cartoon: { color: 'spectrum' } })
      viewer.zoomTo()
      viewer.render()
      viewer.zoom(1.1, 500)
    } catch (e) {
      console.error('3Dmol render failed:', e)
    }

    // Keep the canvas sized to its container.
    const onResize = () => {
      try { viewer.resize() } catch { /* viewer may be torn down */ }
    }
    window.addEventListener('resize', onResize)

    return () => {
      window.removeEventListener('resize', onResize)
      try { viewer.clear() } catch { /* ignore */ }
      viewerRef.current = null
    }
  }, [pdb])

  return (
    <div
      ref={containerRef}
      className="viewer-container relative w-full"
      style={{ height: 400 }}
    />
  )
}
